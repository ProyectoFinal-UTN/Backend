import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  comercio,
  member,
  movimiento,
  organization,
  user,
} from "../src/db/schema.js";

/**
 * Test de integracion de HU-21 (historial de compras por proveedor).
 *
 * Corre contra la base real, igual que tests/historial.test.js. Arma un
 * comercio con compras conocidas a tres proveedores en tres momentos
 * distintos, mas los movimientos que NO son compras y una compra sin
 * proveedor, y verifica que el historial de cada proveedor traiga exactamente
 * lo suyo, que el resumen sea del periodo y no de la pagina, y que un comercio
 * no vea las compras de otro.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu21-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

const ID_INEXISTENTE = "123e4567-e89b-12d3-a456-426614174999";

// Las tres compras a X se corren a estos instantes para probar el filtro por
// periodo contra fechas conocidas. La app nunca edita el libro: esto es
// fixture, igual que en tests/historial.test.js.
const FECHA_VIEJA = new Date("2026-03-02T12:00:00.000Z");
const FECHA_MEDIA = new Date("2026-06-15T12:00:00.000Z");

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `77901${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
}

async function registrarComercio(etiqueta) {
  const email = correo(etiqueta);

  const respuesta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: `Usuario ${etiqueta}`, email, password: PASSWORD });

  expect(respuesta.status).toBe(200);

  const cookie = (respuesta.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");

  return { email, cookie };
}

async function crearProducto(cookie, nombre, stockActual) {
  const respuesta = await request(app)
    .post("/api/productos")
    .set("Cookie", cookie)
    .send({
      nombre,
      codigoBarras: codigoBarras(),
      categoria: "Almacén",
      unidadMedida: "unidad",
      umbralMinimo: 2,
      stockActual,
    });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

async function crearProveedor(cookie, nombre) {
  const respuesta = await request(app)
    .post("/api/proveedores")
    .set("Cookie", cookie)
    .send({ nombre });

  expect(respuesta.status).toBe(201);
  return respuesta.body.id;
}

async function registrarMovimiento(cookie, datos) {
  const respuesta = await request(app)
    .post("/api/movimientos")
    .set("Cookie", cookie)
    .send(datos);

  expect(respuesta.status).toBe(201);
  return respuesta.body.movimiento;
}

function consultar(cookie, proveedorId, query = {}) {
  return request(app)
    .get(`/api/proveedores/${proveedorId}/historial-compras`)
    .query(query)
    .set("Cookie", cookie);
}

/** Ids de las compras de una respuesta, para comparar sin mirar el orden. */
const idsDe = (respuesta) => respuesta.body.compras.map((c) => c.id).sort();

let comercioA;
let comercioB;

let yerba;
let fideos;
let principalId;
let depositoId;
let proveedorX;
let proveedorY;
let proveedorSinCompras;
let proveedorDeBaja;
let proveedorDeB;

/** Ids del libro de A, por nombre, para armar las expectativas. */
const libro = {};

/**
 * El fixture arma dos comercios con cuatro proveedores, tres productos y nueve
 * movimientos: son mas de veinte viajes a Neon, dos de ellos con el bcrypt de
 * 12 rondas del registro. No entra en los 30 s de `testTimeout` de
 * jest.config.js, asi que este hook lleva el suyo en vez de subir el global
 * para todos los demas archivos.
 */
const TIMEOUT_FIXTURE = 120000;

beforeAll(async () => {
  comercioA = await registrarComercio("a");
  comercioB = await registrarComercio("b");

  proveedorX = await crearProveedor(comercioA.cookie, "Distribuidora X");
  proveedorY = await crearProveedor(comercioA.cookie, "Distribuidora Y");
  proveedorSinCompras = await crearProveedor(comercioA.cookie, "Nunca Le Compré");
  proveedorDeBaja = await crearProveedor(comercioA.cookie, "Ex Proveedor");

  // Cada alta con stock deja su movimiento de ajuste inicial (HU-9), que NO es
  // una compra y no tiene que aparecer en ningun historial.
  yerba = await crearProducto(comercioA.cookie, "Yerba 1kg", 20);
  fideos = await crearProducto(comercioA.cookie, "Fideos 500g", 10);
  principalId = yerba.stock.ubicacionId;

  const [altaYerba] = await db
    .select({ id: movimiento.id })
    .from(movimiento)
    .where(eq(movimiento.productoId, yerba.id));
  libro.altaYerba = altaYerba.id;

  const deposito = await request(app)
    .post("/api/ubicaciones")
    .set("Cookie", comercioA.cookie)
    .send({ nombre: "Depósito" });
  if (deposito.status !== 201) {
    throw new Error(`No se pudo crear la ubicación: ${deposito.status}`);
  }
  depositoId = deposito.body.id;

  // --- Las tres compras a X, en tres momentos distintos -------------------
  libro.compraX1 = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "compra",
      cantidad: 5,
      proveedorId: proveedorX,
      ubicacionId: principalId,
    })
  ).id;

  libro.compraX2 = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: fideos.id,
      tipo: "compra",
      cantidad: 7,
      proveedorId: proveedorX,
      ubicacionId: depositoId,
      motivo: "Pedido mensual",
    })
  ).id;

  // La tercera queda con la fecha de ahora: es la ultima compra a X.
  libro.compraX3 = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "compra",
      cantidad: 9,
      proveedorId: proveedorX,
      ubicacionId: principalId,
    })
  ).id;

  await db
    .update(movimiento)
    .set({ fecha: FECHA_VIEJA })
    .where(eq(movimiento.id, libro.compraX1));
  await db
    .update(movimiento)
    .set({ fecha: FECHA_MEDIA })
    .where(eq(movimiento.id, libro.compraX2));

  // --- Lo que NO tiene que aparecer en el historial de X ------------------
  libro.compraY = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "compra",
      cantidad: 4,
      proveedorId: proveedorY,
      ubicacionId: depositoId,
    })
  ).id;

  // `proveedorId` es opcional en el registro (HU-13): una compra que no dice a
  // quien se le compro no se le puede atribuir a nadie.
  libro.compraSinProveedor = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: fideos.id,
      tipo: "compra",
      cantidad: 6,
      ubicacionId: principalId,
    })
  ).id;

  libro.ventaYerba = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "venta",
      cantidad: 3,
      ubicacionId: principalId,
    })
  ).id;

  libro.mermaFideos = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: fideos.id,
      tipo: "merma",
      cantidad: 1,
      motivo: "Paquete roto",
      ubicacionId: principalId,
    })
  ).id;

  // --- Un proveedor con compras y despues dado de baja -------------------
  libro.compraDeBaja = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "compra",
      cantidad: 2,
      proveedorId: proveedorDeBaja,
      ubicacionId: principalId,
    })
  ).id;

  const baja = await request(app)
    .delete(`/api/proveedores/${proveedorDeBaja}`)
    .set("Cookie", comercioA.cookie);
  if (baja.status !== 204) {
    throw new Error(`No se pudo dar de baja al proveedor: ${baja.status}`);
  }

  // --- Un comercio B, que A nunca tiene que ver --------------------------
  const deB = await crearProducto(comercioB.cookie, "Producto de B", 8);
  proveedorDeB = await crearProveedor(comercioB.cookie, "Distribuidora X");
  libro.compraDeB = (
    await registrarMovimiento(comercioB.cookie, {
      productoId: deB.id,
      tipo: "compra",
      cantidad: 2,
      proveedorId: proveedorDeB,
    })
  ).id;
}, TIMEOUT_FIXTURE);

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // Mismo orden que tests/historial.test.js: el comercio antes que el usuario,
  // porque `movimiento.usuario_id` es `restrict`.
  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
}, TIMEOUT_FIXTURE);

describe("GET /api/proveedores/:id/historial-compras — éxito", () => {
  test("trae las compras del proveedor, de la más nueva a la más vieja", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.compras.map((c) => c.id)).toEqual([
      libro.compraX3,
      libro.compraX2,
      libro.compraX1,
    ]);
  });

  test("identifica al proveedor para que la pantalla pueda titular", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX);

    expect(respuesta.body.proveedor).toEqual({
      id: proveedorX,
      nombre: "Distribuidora X",
      activo: true,
    });
  });

  test("cada fila trae su producto y su ubicación resueltos", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX);
    const compra = respuesta.body.compras.find((c) => c.id === libro.compraX2);

    expect(compra).toMatchObject({
      cantidad: 7,
      motivo: "Pedido mensual",
      producto: {
        id: fideos.id,
        nombre: "Fideos 500g",
        unidadMedida: "unidad",
        activo: true,
      },
      ubicacion: { id: depositoId, nombre: "Depósito" },
    });
    expect(compra.producto.codigoBarras).toBeTruthy();
    expect(typeof compra.fecha).toBe("string");
  });

  test("la cantidad de una compra es positiva: es una entrada", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX);

    for (const compra of respuesta.body.compras) {
      expect(compra.cantidad).toBeGreaterThan(0);
    }
  });

  // El criterio pide fechas, productos y montos. Sin el campo `usuario` no hay
  // que reimplementar el recorte de correos por rol de HU-32.
  test("no expone quién registró la compra", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX);

    for (const compra of respuesta.body.compras) {
      expect(compra).not.toHaveProperty("usuario");
      expect(compra).not.toHaveProperty("usuarioId");
    }
    expect(JSON.stringify(respuesta.body)).not.toContain(comercioA.email);
  });
});

describe("resumen del período", () => {
  test("cuenta las compras y suma las unidades de todo el período", async () => {
    const { resumen } = (await consultar(comercioA.cookie, proveedorX)).body;

    expect(resumen.compras).toBe(3);
    expect(resumen.unidades).toBe(21); // 5 + 7 + 9
  });

  test("informa la primera y la última compra", async () => {
    const { resumen } = (await consultar(comercioA.cookie, proveedorX)).body;

    expect(new Date(resumen.primeraCompra)).toEqual(FECHA_VIEJA);
    expect(new Date(resumen.ultimaCompra).getTime()).toBeGreaterThan(
      FECHA_MEDIA.getTime(),
    );
  });

  // Un total que cambia al pasar de pagina no es un total.
  test("no depende de la página que se esté mirando", async () => {
    const primera = await consultar(comercioA.cookie, proveedorX, {
      limite: 1,
      pagina: 1,
    });
    const ultima = await consultar(comercioA.cookie, proveedorX, {
      limite: 1,
      pagina: 3,
    });

    expect(primera.body.compras).toHaveLength(1);
    expect(primera.body.resumen).toEqual(ultima.body.resumen);
    expect(primera.body.resumen.unidades).toBe(21);
  });

  // LIMITACION CONOCIDA de la HU: el modelo de movimientos (HU-13) no guarda
  // precio ni costo, asi que no hay montos para informar. Explicito en `null`
  // para que el Frontend lo sepa en vez de adivinarlo.
  test("los montos vienen en null: el modelo no tiene precios", async () => {
    const { resumen } = (await consultar(comercioA.cookie, proveedorX)).body;

    expect(resumen.montos).toBeNull();
  });

  test("se acota al período pedido, igual que las filas", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      desde: "2026-03-01T00:00:00.000Z",
      hasta: "2026-07-01T00:00:00.000Z",
    });

    expect(idsDe(respuesta)).toEqual([libro.compraX1, libro.compraX2].sort());
    expect(respuesta.body.resumen).toMatchObject({
      compras: 2,
      unidades: 12, // 5 + 7
    });
  });
});

describe("lo que el historial NO incluye", () => {
  test("los movimientos que no son compras quedan afuera", async () => {
    const todos = await consultar(comercioA.cookie, proveedorX, { limite: 200 });
    const ids = idsDe(todos);

    // El ajuste del alta con stock inicial (HU-9) tambien es una entrada, y
    // tampoco es una compra.
    for (const id of [libro.ventaYerba, libro.mermaFideos, libro.altaYerba]) {
      expect(ids).not.toContain(id);
    }
  });

  test("las compras sin proveedor no aparecen en ningún historial", async () => {
    for (const proveedorId of [proveedorX, proveedorY, proveedorSinCompras]) {
      const respuesta = await consultar(comercioA.cookie, proveedorId, {
        limite: 200,
      });

      expect(idsDe(respuesta)).not.toContain(libro.compraSinProveedor);
    }
  });

  test("las compras a otro proveedor no aparecen", async () => {
    const deX = await consultar(comercioA.cookie, proveedorX, { limite: 200 });
    const deY = await consultar(comercioA.cookie, proveedorY, { limite: 200 });

    expect(idsDe(deX)).not.toContain(libro.compraY);
    expect(idsDe(deY)).toEqual([libro.compraY]);
    expect(deY.body.resumen).toMatchObject({ compras: 1, unidades: 4 });
  });
});

describe("casos borde del proveedor", () => {
  test("un proveedor sin compras devuelve 200 con el historial vacío", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorSinCompras);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.compras).toEqual([]);
    expect(respuesta.body.resumen).toEqual({
      compras: 0,
      unidades: 0,
      primeraCompra: null,
      ultimaCompra: null,
      montos: null,
    });
    expect(respuesta.body.paginacion).toMatchObject({ total: 0, totalPaginas: 0 });
  });

  // El historial tiene que seguir mostrando a quien se le compro aunque hoy ya
  // no se le compre mas: es justo lo que la HU pide evaluar.
  test("un proveedor dado de baja conserva su historial", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorDeBaja);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.proveedor).toEqual({
      id: proveedorDeBaja,
      nombre: "Ex Proveedor",
      activo: false,
    });
    expect(idsDe(respuesta)).toEqual([libro.compraDeBaja]);
  });

  test("un proveedor que no existe devuelve 404", async () => {
    const respuesta = await consultar(comercioA.cookie, ID_INEXISTENTE);

    expect(respuesta.status).toBe(404);
    expect(respuesta.body).toEqual({ error: "El proveedor no existe" });
  });

  // Sin el chequeo de UUID, Postgres tira 22P02 y el 404 sale como 500.
  test("un id que no es UUID devuelve 404 y no 500", async () => {
    const respuesta = await consultar(comercioA.cookie, "no-soy-un-uuid");

    expect(respuesta.status).toBe(404);
    expect(respuesta.body).toEqual({ error: "El proveedor no existe" });
  });

  // 404 y no 403: decir "existe pero no es tuyo" filtraria informacion de otro
  // comercio.
  test("el proveedor de otro comercio devuelve 404, con el mismo mensaje", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorDeB);

    expect(respuesta.status).toBe(404);
    expect(respuesta.body).toEqual({ error: "El proveedor no existe" });
    expect(JSON.stringify(respuesta.body)).not.toContain(proveedorDeB);
  });

  test("B ve sus propias compras y ninguna de A", async () => {
    const respuesta = await consultar(comercioB.cookie, proveedorDeB);

    expect(respuesta.status).toBe(200);
    expect(idsDe(respuesta)).toEqual([libro.compraDeB]);
  });

  test("sin sesión devuelve 401", async () => {
    const respuesta = await request(app).get(
      `/api/proveedores/${proveedorX}/historial-compras`,
    );

    expect(respuesta.status).toBe(401);
  });
});

describe("filtro por período", () => {
  test("acota por desde y hasta", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      desde: "2026-06-01T00:00:00.000Z",
      hasta: "2026-06-30T00:00:00.000Z",
    });

    expect(idsDe(respuesta)).toEqual([libro.compraX2]);
  });

  test("período abierto: solo desde", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      desde: "2026-06-01T00:00:00.000Z",
    });

    expect(idsDe(respuesta)).toEqual([libro.compraX2, libro.compraX3].sort());
  });

  test("período abierto: solo hasta", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      hasta: "2026-06-30T00:00:00.000Z",
    });

    expect(idsDe(respuesta)).toEqual([libro.compraX1, libro.compraX2].sort());
  });

  test("los límites son inclusive", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      desde: FECHA_VIEJA.toISOString(),
      hasta: FECHA_VIEJA.toISOString(),
    });

    expect(idsDe(respuesta)).toEqual([libro.compraX1]);
  });

  test("un período sin compras devuelve 200 y lista vacía", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      desde: "2030-01-01T00:00:00.000Z",
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.compras).toEqual([]);
    expect(respuesta.body.paginacion.total).toBe(0);
    expect(respuesta.body.resumen.primeraCompra).toBeNull();
  });

  test("una fecha sin zona es 400", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      desde: "2026-01-01",
    });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/ISO 8601 con zona/);
  });

  test("desde posterior a hasta es 400", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      desde: "2026-12-31T00:00:00.000Z",
      hasta: "2026-01-01T00:00:00.000Z",
    });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/no puede ser posterior/);
  });

  // El filtro invalido se corta antes de resolver el proveedor: no hace falta
  // que exista para saber que la query esta mal.
  test("el 400 del filtro gana sobre el 404 del proveedor", async () => {
    const respuesta = await consultar(comercioA.cookie, ID_INEXISTENTE, {
      desde: "2026-01-01",
    });

    expect(respuesta.status).toBe(400);
  });
});

describe("paginación", () => {
  test("pagina y recorre todas las compras sin repetir ni saltear", async () => {
    const paginas = await Promise.all(
      [1, 2, 3].map((pagina) =>
        consultar(comercioA.cookie, proveedorX, { limite: 1, pagina }),
      ),
    );

    const vistos = paginas.flatMap((p) => p.body.compras.map((c) => c.id));

    expect(vistos).toEqual([libro.compraX3, libro.compraX2, libro.compraX1]);
    expect(new Set(vistos).size).toBe(3);
    expect(paginas[0].body.paginacion).toEqual({
      pagina: 1,
      limite: 1,
      total: 3,
      totalPaginas: 3,
    });
  });

  test("la última página puede venir parcial", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      limite: 2,
      pagina: 2,
    });

    expect(respuesta.body.compras).toHaveLength(1);
    expect(respuesta.body.paginacion).toMatchObject({
      total: 3,
      totalPaginas: 2,
    });
  });

  test("el límite máximo se acepta tal cual", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      limite: 200,
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.paginacion.limite).toBe(200);
  });

  // Se recorta en vez de rechazar: pedir de mas no es un error del usuario.
  test("un límite por encima del máximo se recorta a 200", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      limite: 201,
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.paginacion.limite).toBe(200);
  });

  test("una página más allá del total devuelve lista vacía, no 404", async () => {
    const respuesta = await consultar(comercioA.cookie, proveedorX, {
      pagina: 99,
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.compras).toEqual([]);
    expect(respuesta.body.paginacion).toMatchObject({ pagina: 99, total: 3 });
  });

  test("una paginación que no es un entero positivo es 400", async () => {
    for (const query of [{ limite: 0 }, { pagina: 0 }, { limite: "1e3" }]) {
      const respuesta = await consultar(comercioA.cookie, proveedorX, query);

      expect(respuesta.status).toBe(400);
      expect(respuesta.body.error).toMatch(/número entero mayor a 0/);
    }
  });
});
