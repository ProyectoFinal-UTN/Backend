import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, user } from "../src/db/schema.js";
import { importarProductos } from "../src/services/productosImportacion.service.js";

/**
 * Test de integracion de HU-7 (importacion de catalogo desde CSV).
 *
 * Corre contra la base real, con el mismo andamiaje que tests/productos.test.js:
 * lo que hay que verificar es que las filas validas queden efectivamente
 * commiteadas —con su fila de STOCK— cuando otras del mismo archivo fallan, y
 * eso solo se puede comprobar con transacciones de verdad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu7-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

let contadorCodigo = 0;
/** Codigo de barras unico por test, para no chocar entre corridas. */
function codigoBarras() {
  contadorCodigo += 1;
  return `${Date.now()}${contadorCodigo}`.slice(-12);
}

const ENCABEZADO = "nombre,codigo_barras,categoria,unidad_medida,umbral_minimo,stock_actual";

/** Sube un CSV al endpoint de importacion como si viniera de un <input type="file">. */
function importar(cookie, contenido, nombreArchivo = "catalogo.csv") {
  return request(app)
    .post("/api/productos/importar")
    .set("Cookie", cookie)
    .attach("archivo", Buffer.from(contenido, "utf8"), nombreArchivo);
}

async function registrarComercio(etiqueta) {
  const email = correo(etiqueta);

  const respuesta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: `Comercio ${etiqueta}`, email, password: PASSWORD });

  expect(respuesta.status).toBe(200);

  const cookie = (respuesta.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");

  return { email, cookie };
}

let propietarioA;
let propietarioB;

beforeAll(async () => {
  propietarioA = await registrarComercio("a");
  propietarioB = await registrarComercio("b");
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // Mismo orden que tests/productos.test.js: el comercio primero (se lleva
  // producto/ubicacion/stock/movimiento por cascada), despues el usuario, que
  // no se puede borrar mientras tenga movimientos (onDelete: restrict).
  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

describe("Sin sesión", () => {
  test("no se puede importar", async () => {
    const respuesta = await request(app)
      .post("/api/productos/importar")
      .attach("archivo", Buffer.from(`${ENCABEZADO}\n`), "catalogo.csv");

    expect(respuesta.status).toBe(401);
  });
});

describe("Importación exitosa", () => {
  test("importa las filas válidas y las deja disponibles en stock", async () => {
    const uno = codigoBarras();
    const dos = codigoBarras();

    const respuesta = await importar(
      propietarioA.cookie,
      `${ENCABEZADO}\n` +
        `Coca-Cola 500ml,${uno},Bebidas,unidad,5,20\n` +
        `Yerba 1kg,${dos},Almacén,kg,2,8\n`,
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toMatchObject({
      totalFilas: 2,
      procesadas: 2,
      importados: 2,
      fallidos: 0,
      interrumpido: false,
      interrupcion: null,
    });
    expect(respuesta.body.errores).toEqual([]);
    expect(respuesta.body.productos.map((p) => p.fila)).toEqual([2, 3]);

    // El criterio de aceptación dice "quedan disponibles en stock": no alcanza
    // con que el producto exista, tiene que tener su saldo cargado.
    const detalle = await request(app)
      .get(`/api/productos/${respuesta.body.productos[0].id}`)
      .set("Cookie", propietarioA.cookie);

    expect(detalle.status).toBe(200);
    expect(detalle.body.stock.total).toBe(20);
    expect(detalle.body.umbralMinimo).toBe(5);
  });

  test("una celda de stock vacía se importa como 0", async () => {
    const respuesta = await importar(
      propietarioA.cookie,
      `${ENCABEZADO}\nAgua sin gas,${codigoBarras()},Bebidas,l,,\n`,
    );

    expect(respuesta.body.importados).toBe(1);

    const detalle = await request(app)
      .get(`/api/productos/${respuesta.body.productos[0].id}`)
      .set("Cookie", propietarioA.cookie);

    expect(detalle.body.stock.total).toBe(0);
    expect(detalle.body.umbralMinimo).toBe(0);
  });

  test("acepta un archivo exportado por Excel: separador ';', BOM y acentos", async () => {
    const respuesta = await importar(
      propietarioA.cookie,
      `\uFEFFNombre;Código de Barras;Categoría;Unidad Medida;Stock Actual\n` +
        `Fideos;${codigoBarras()};Almacén;paquete;12\n`,
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.importados).toBe(1);
  });
});

describe("Filas con error — no abortan la carga", () => {
  test("una fila inválida se informa y las demás se importan igual", async () => {
    const valido = codigoBarras();

    const respuesta = await importar(
      propietarioA.cookie,
      `${ENCABEZADO}\n` +
        `Producto malo,${codigoBarras()},Bebidas,toneladas,0,1\n` +
        `Producto bueno,${valido},Bebidas,unidad,1,4\n` +
        // Fila sin nombre: la primera celda va vacía a propósito.
        `,${codigoBarras()},Bebidas,unidad,0,1\n`,
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.totalFilas).toBe(3);
    expect(respuesta.body.procesadas).toBe(3);
    expect(respuesta.body.importados).toBe(1);
    expect(respuesta.body.fallidos).toBe(2);
    // Filas rechazadas por sus datos no son una interrupción: el archivo se
    // procesó entero.
    expect(respuesta.body.interrumpido).toBe(false);

    // La fila válida del medio entró pese a tener una fila con error de cada
    // lado: es exactamente el criterio de aceptación de la historia.
    expect(respuesta.body.productos[0]).toMatchObject({
      fila: 3,
      codigoBarras: valido,
    });

    expect(respuesta.body.errores[0]).toMatchObject({ fila: 2 });
    expect(respuesta.body.errores[0].motivo).toMatch(/unidad de medida/i);
    expect(respuesta.body.errores[1]).toMatchObject({ fila: 4 });
    expect(respuesta.body.errores[1].motivo).toMatch(/nombre/i);

    const listado = await request(app)
      .get("/api/productos")
      .set("Cookie", propietarioA.cookie);

    expect(listado.body.map((p) => p.codigoBarras)).toContain(valido);
  });

  test("un stock no numérico se rechaza con el mismo mensaje que el alta individual", async () => {
    const respuesta = await importar(
      propietarioA.cookie,
      `${ENCABEZADO}\nRaro,${codigoBarras()},Bebidas,unidad,0,muchas\n`,
    );

    expect(respuesta.body.fallidos).toBe(1);
    expect(respuesta.body.errores[0].motivo).toMatch(/stock actual/i);
  });

  test("el código de barras duplicado contra un producto activo se reporta como fila con error", async () => {
    const repetido = codigoBarras();

    const primera = await importar(
      propietarioA.cookie,
      `${ENCABEZADO}\nOriginal,${repetido},Bebidas,unidad,0,5\n`,
    );
    expect(primera.body.importados).toBe(1);

    const otro = codigoBarras();
    const segunda = await importar(
      propietarioA.cookie,
      `${ENCABEZADO}\n` +
        `Repetido,${repetido},Bebidas,unidad,0,5\n` +
        `Nuevo,${otro},Bebidas,unidad,0,5\n`,
    );

    expect(segunda.status).toBe(200);
    expect(segunda.body.importados).toBe(1);
    expect(segunda.body.fallidos).toBe(1);
    expect(segunda.body.errores[0]).toMatchObject({
      fila: 2,
      codigoBarras: repetido,
    });
    expect(segunda.body.errores[0].motivo).toMatch(/ya existe un producto/i);
    // Lo importante: el duplicado no frenó la fila siguiente.
    expect(segunda.body.productos[0].codigoBarras).toBe(otro);
  });

  test("un código repetido dentro del mismo archivo indica en qué fila venía", async () => {
    const repetido = codigoBarras();

    const respuesta = await importar(
      propietarioA.cookie,
      `${ENCABEZADO}\n` +
        `Primero,${repetido},Bebidas,unidad,0,5\n` +
        `Segundo,${repetido},Bebidas,unidad,0,5\n`,
    );

    expect(respuesta.body.importados).toBe(1);
    expect(respuesta.body.errores[0]).toMatchObject({ fila: 3 });
    expect(respuesta.body.errores[0].motivo).toMatch(/repetido en el archivo/i);
    expect(respuesta.body.errores[0].motivo).toMatch(/fila 2/);
  });

  test("una ubicación que no existe en el comercio es un error de fila", async () => {
    const bueno = codigoBarras();

    const respuesta = await importar(
      propietarioA.cookie,
      `${ENCABEZADO},ubicacion\n` +
        `Fantasma,${codigoBarras()},Bebidas,unidad,0,1,Sucursal Marte\n` +
        `Normal,${bueno},Bebidas,unidad,0,1,\n`,
    );

    expect(respuesta.body.fallidos).toBe(1);
    expect(respuesta.body.errores[0].motivo).toMatch(/sucursal marte/i);
    expect(respuesta.body.productos[0].codigoBarras).toBe(bueno);
  });

  test("importa a una ubicación existente nombrada en el CSV, sin acentos exactos", async () => {
    const creada = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Depósito" });
    expect(creada.status).toBe(201);

    const respuesta = await importar(
      propietarioA.cookie,
      `${ENCABEZADO},ubicacion\nEn depo,${codigoBarras()},Bebidas,unidad,0,9,deposito\n`,
    );

    expect(respuesta.body.importados).toBe(1);

    const detalle = await request(app)
      .get(`/api/productos/${respuesta.body.productos[0].id}`)
      .set("Cookie", propietarioA.cookie);

    const enDeposito = detalle.body.stock.porUbicacion.find(
      (u) => u.ubicacionId === creada.body.id,
    );
    expect(enDeposito.cantidad).toBe(9);
  });

  test("con dos ubicaciones que solo difieren en acentos, exige el nombre exacto", async () => {
    // La base permite las dos: su unique es por nombre exacto. Resolverlas por
    // nombre "sin acentos" las colapsaria y el stock podria caer en la que no
    // era, sin ningún aviso.
    const tienda = await registrarComercio("acentos");

    const conAcento = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", tienda.cookie)
      .send({ nombre: "Depósito" });
    const sinAcento = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", tienda.cookie)
      .send({ nombre: "Deposito" });

    expect(conAcento.status).toBe(201);
    expect(sinAcento.status).toBe(201);

    const ambigua = await importar(
      tienda.cookie,
      `${ENCABEZADO},ubicacion\nDudoso,${codigoBarras()},Bebidas,unidad,0,1,DEPOSITO\n`,
    );

    expect(ambigua.body.fallidos).toBe(1);
    expect(ambigua.body.errores[0].motivo).toMatch(/ambigua/i);

    // Escrito exactamente como está en la configuración, entra sin dudas.
    const exacta = await importar(
      tienda.cookie,
      `${ENCABEZADO},ubicacion\nPreciso,${codigoBarras()},Bebidas,unidad,0,4,Depósito\n`,
    );

    expect(exacta.body.importados).toBe(1);

    const detalle = await request(app)
      .get(`/api/productos/${exacta.body.productos[0].id}`)
      .set("Cookie", tienda.cookie);

    const fila = detalle.body.stock.porUbicacion.find(
      (u) => u.ubicacionId === conAcento.body.id,
    );
    expect(fila.cantidad).toBe(4);
  });
});

describe("Corte por un error de sistema", () => {
  /**
   * Fuerza un error que NO es de negocio en el medio del loop, sin mocks.
   *
   * Se apoya en dos cosas que ya estan en el codigo:
   *
   * - `movimiento.usuario_id` es una FK a `user.id` (schema.js), asi que un
   *   usuarioId inexistente hace fallar el INSERT con 23503, que es un error de
   *   driver y no un `ErrorDeNegocio`.
   * - `crearProducto` solo llama a `aplicarMovimiento` cuando el stock inicial
   *   es mayor a 0; con stock 0 inserta la fila de `stock` directo y no toca
   *   `movimiento` (HU-9).
   *
   * Combinando las dos, las filas con stock 0 se importan y las que traen stock
   * revientan. Si algun dia HU-9 cambia y empieza a registrar un movimiento
   * tambien con stock 0, este test se rompe: no es un falso positivo, hay que
   * buscar otra forma de provocar el error de sistema.
   *
   * Se llama al service directo y no por HTTP porque el `usuarioId` de un
   * request siempre sale de la sesion y por definicion existe.
   */
  const USUARIO_INEXISTENTE = "usuario-que-no-existe";

  async function comercioDePrueba(etiqueta) {
    const registrado = await registrarComercio(etiqueta);

    const [fila] = await db
      .select({ comercioId: comercio.id })
      .from(comercio)
      .innerJoin(organization, eq(organization.id, comercio.organizationId))
      .innerJoin(member, eq(member.organizationId, organization.id))
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, registrado.email));

    return { ...registrado, comercioId: fila.comercioId };
  }

  test("devuelve lo que alcanzó a importar, marcado como interrumpido", async () => {
    const tienda = await comercioDePrueba("corte");

    const csv =
      `${ENCABEZADO}\n` +
      `Entra 1,${codigoBarras()},Bebidas,unidad,0,0\n` +
      `Entra 2,${codigoBarras()},Bebidas,unidad,0,0\n` +
      `Rompe,${codigoBarras()},Bebidas,unidad,0,5\n` +
      `Nunca se procesa,${codigoBarras()},Bebidas,unidad,0,0\n`;

    const resultado = await importarProductos(
      tienda.comercioId,
      USUARIO_INEXISTENTE,
      Buffer.from(csv, "utf8"),
    );

    expect(resultado.interrumpido).toBe(true);
    expect(resultado.interrupcion.fila).toBe(4);
    expect(resultado.interrupcion.motivo).toMatch(/volvé a subir/i);

    expect(resultado.totalFilas).toBe(4);
    expect(resultado.procesadas).toBe(2);
    expect(resultado.importados).toBe(2);
    expect(resultado.fallidos).toBe(0);
    // El invariante que sigue valiendo aunque se corte.
    expect(resultado.importados + resultado.fallidos).toBe(
      resultado.procesadas,
    );

    // La fila del corte no se reporta como dato a corregir.
    expect(resultado.errores).toEqual([]);

    // Y lo importado quedó de verdad: es el punto de todo el cambio.
    const listado = await request(app)
      .get("/api/productos")
      .set("Cookie", tienda.cookie);

    const nombres = listado.body.map((p) => p.nombre);
    expect(nombres).toContain("Entra 1");
    expect(nombres).toContain("Entra 2");
    expect(nombres).not.toContain("Rompe");
    expect(nombres).not.toContain("Nunca se procesa");
  });

  test("si no llegó a importar nada, lanza en vez de devolver un reporte vacío", async () => {
    const tienda = await comercioDePrueba("corte-seco");

    // Unica fila, y con stock: falla la primera, no hay nada commiteado que
    // reportar, asi que el 500 es la respuesta honesta.
    const csv = `${ENCABEZADO}\nRompe ya,${codigoBarras()},Bebidas,unidad,0,5\n`;

    await expect(
      importarProductos(
        tienda.comercioId,
        USUARIO_INEXISTENTE,
        Buffer.from(csv, "utf8"),
      ),
    ).rejects.toThrow();
  });
});

describe("Rechazos del archivo completo", () => {
  test("falta una columna obligatoria: 400 y ninguna fila importada", async () => {
    const respuesta = await importar(
      propietarioA.cookie,
      `nombre,categoria,unidad_medida\nAgua,Bebidas,l\n`,
    );

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/codigo_barras/);
  });

  test("archivo sin filas de datos: 400", async () => {
    const respuesta = await importar(propietarioA.cookie, `${ENCABEZADO}\n`);

    expect(respuesta.status).toBe(400);
  });

  test("no se envió ningún archivo: 400", async () => {
    const respuesta = await request(app)
      .post("/api/productos/importar")
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(400);
  });

  test("un archivo que no es CSV se rechaza", async () => {
    const respuesta = await request(app)
      .post("/api/productos/importar")
      .set("Cookie", propietarioA.cookie)
      .attach("archivo", Buffer.from("no soy un csv"), {
        filename: "catalogo.pdf",
        contentType: "application/pdf",
      });

    expect(respuesta.status).toBe(400);
  });
});

describe("Aislamiento entre comercios y roles", () => {
  test("lo que importa un comercio no aparece en el catálogo de otro", async () => {
    const codigo = codigoBarras();

    await importar(
      propietarioB.cookie,
      `${ENCABEZADO}\nSolo de B,${codigo},Bebidas,unidad,0,3\n`,
    );

    const deA = await request(app)
      .get("/api/productos")
      .set("Cookie", propietarioA.cookie);

    expect(deA.body.map((p) => p.codigoBarras)).not.toContain(codigo);
  });

  test("un empleado no puede importar", async () => {
    const empleado = await registrarComercio("empleado");

    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, empleado.email));

    await db
      .update(member)
      .set({ role: "empleado" })
      .where(eq(member.userId, fila.id));

    const respuesta = await importar(
      empleado.cookie,
      `${ENCABEZADO}\nNo va,${codigoBarras()},Bebidas,unidad,0,1\n`,
    );

    expect(respuesta.status).toBe(403);
  });
});
