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
 * Test de integracion de HU-14 (consulta del historial de movimientos).
 *
 * Corre contra la base real, igual que tests/movimientos.test.js. Arma un
 * comercio con un libro conocido —dos productos, dos ubicaciones, dos
 * proveedores y movimientos de cada tipo— y verifica cada filtro por separado,
 * sus combinaciones, que cada fila traiga todos sus datos y que un comercio no
 * vea el libro de otro.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu14-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

// Todavia no existe la tabla PROVEEDOR (HU-19): `movimiento.proveedor_id` no
// tiene FK, asi que alcanza con dos UUID fijos para probar el filtro.
const PROVEEDOR_X = "a0000000-0000-4000-8000-000000000001";
const PROVEEDOR_Y = "a0000000-0000-4000-8000-000000000002";

// Instante del pasado al que se mueven las altas iniciales, para probar el
// filtro por fechas contra movimientos que no ocurrieron "recien".
const FECHA_VIEJA = new Date("2020-01-15T12:00:00.000Z");

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `77900${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
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

async function registrarMovimiento(cookie, datos) {
  const respuesta = await request(app)
    .post("/api/movimientos")
    .set("Cookie", cookie)
    .send(datos);

  expect(respuesta.status).toBe(201);
  return respuesta.body.movimiento;
}

function consultar(cookie, query = {}) {
  return request(app).get("/api/movimientos").query(query).set("Cookie", cookie);
}

/** Ids de los movimientos de una respuesta, para comparar sin mirar orden. */
const idsDe = (respuesta) =>
  respuesta.body.movimientos.map((m) => m.id).sort();

let comercioA;
let comercioB;

/** Ids del libro de A, por nombre, para armar las expectativas. */
const libro = {};
let yerba;
let fideos;
let principalId;
let depositoId;

beforeAll(async () => {
  comercioA = await registrarComercio("a");
  comercioB = await registrarComercio("b");

  // Cada alta con stock deja su movimiento de ajuste inicial (HU-9).
  yerba = await crearProducto(comercioA.cookie, "Yerba 1kg", 20);
  fideos = await crearProducto(comercioA.cookie, "Fideos 500g", 10);
  principalId = yerba.stock.ubicacionId;

  const deposito = await request(app)
    .post("/api/ubicaciones")
    .set("Cookie", comercioA.cookie)
    .send({ nombre: "Depósito" });
  if (deposito.status !== 201) {
    throw new Error(`No se pudo crear la ubicación: ${deposito.status}`);
  }
  depositoId = deposito.body.id;

  const [altaYerba] = await db
    .select({ id: movimiento.id })
    .from(movimiento)
    .where(eq(movimiento.productoId, yerba.id));
  const [altaFideos] = await db
    .select({ id: movimiento.id })
    .from(movimiento)
    .where(eq(movimiento.productoId, fideos.id));
  libro.altaYerba = altaYerba.id;
  libro.altaFideos = altaFideos.id;

  // Fixture de test, no un flujo de la app: la app nunca edita el libro. Se
  // corre la fecha de las altas al pasado para tener movimientos en dos
  // momentos distintos.
  await db
    .update(movimiento)
    .set({ fecha: FECHA_VIEJA })
    .where(inArray(movimiento.id, [libro.altaYerba, libro.altaFideos]));

  libro.compraYerbaX = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "compra",
      cantidad: 5,
      proveedorId: PROVEEDOR_X,
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

  libro.compraYerbaYDeposito = (
    await registrarMovimiento(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "compra",
      cantidad: 4,
      proveedorId: PROVEEDOR_Y,
      ubicacionId: depositoId,
    })
  ).id;

  // Un libro en B, que A nunca tiene que ver.
  const deB = await crearProducto(comercioB.cookie, "Producto de B", 8);
  await registrarMovimiento(comercioB.cookie, {
    productoId: deB.id,
    tipo: "compra",
    cantidad: 2,
    proveedorId: PROVEEDOR_X,
  });
  libro.productoDeB = deB.id;
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // Mismo orden que tests/movimientos.test.js: el comercio antes que el
  // usuario, porque `movimiento.usuario_id` es `restrict`.
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
  test("no se puede consultar el historial", async () => {
    const respuesta = await request(app).get("/api/movimientos");

    expect(respuesta.status).toBe(401);
  });
});

describe("Listado sin filtros", () => {
  test("devuelve todo el libro del comercio, del más nuevo al más viejo", async () => {
    const respuesta = await consultar(comercioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.paginacion.total).toBe(6);

    const ids = respuesta.body.movimientos.map((m) => m.id);
    // Los cuatro registrados por la API, en orden inverso, y despues las dos
    // altas del pasado.
    expect(ids.slice(0, 4)).toEqual([
      libro.compraYerbaYDeposito,
      libro.mermaFideos,
      libro.ventaYerba,
      libro.compraYerbaX,
    ]);
    expect(ids.slice(4).sort()).toEqual(
      [libro.altaYerba, libro.altaFideos].sort(),
    );
  });

  test("cada movimiento trae todos sus datos asociados", async () => {
    const respuesta = await consultar(comercioA.cookie);
    const merma = respuesta.body.movimientos.find(
      (m) => m.id === libro.mermaFideos,
    );

    expect(merma).toEqual({
      id: libro.mermaFideos,
      fecha: expect.any(String),
      tipo: "merma",
      cantidad: -1,
      motivo: "Paquete roto",
      proveedorId: null,
      transferenciaId: null,
      producto: {
        id: fideos.id,
        nombre: "Fideos 500g",
        codigoBarras: fideos.codigoBarras,
        unidadMedida: "unidad",
        activo: true,
      },
      ubicacion: { id: principalId, nombre: expect.any(String) },
      usuario: {
        id: expect.any(String),
        nombre: "Usuario a",
        correo: comercioA.email,
      },
    });
  });

  test("la cantidad sale con signo, como está en el libro", async () => {
    const respuesta = await consultar(comercioA.cookie);
    const porId = Object.fromEntries(
      respuesta.body.movimientos.map((m) => [m.id, m.cantidad]),
    );

    expect(porId[libro.compraYerbaX]).toBe(5);
    expect(porId[libro.ventaYerba]).toBe(-3);
  });
});

describe("Filtros individuales", () => {
  test("por producto", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      productoId: fideos.id,
    });

    expect(respuesta.status).toBe(200);
    expect(idsDe(respuesta)).toEqual(
      [libro.altaFideos, libro.mermaFideos].sort(),
    );
  });

  test("por tipo", async () => {
    const respuesta = await consultar(comercioA.cookie, { tipo: "compra" });

    expect(idsDe(respuesta)).toEqual(
      [libro.compraYerbaX, libro.compraYerbaYDeposito].sort(),
    );
  });

  test("por proveedor", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      proveedorId: PROVEEDOR_X,
    });

    // El movimiento de B con el mismo proveedor no aparece.
    expect(idsDe(respuesta)).toEqual([libro.compraYerbaX]);
    expect(respuesta.body.movimientos[0].proveedorId).toBe(PROVEEDOR_X);
  });

  test("por ubicación", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      ubicacionId: depositoId,
    });

    expect(idsDe(respuesta)).toEqual([libro.compraYerbaYDeposito]);
    expect(respuesta.body.movimientos[0].ubicacion.nombre).toBe("Depósito");
  });

  test("por rango de fechas: solo hasta", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      hasta: "2020-12-31T23:59:59.999Z",
    });

    expect(idsDe(respuesta)).toEqual(
      [libro.altaYerba, libro.altaFideos].sort(),
    );
  });

  test("por rango de fechas: solo desde", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      desde: "2021-01-01T00:00:00.000Z",
    });

    expect(respuesta.body.paginacion.total).toBe(4);
    expect(idsDe(respuesta)).not.toContain(libro.altaYerba);
  });

  test("los extremos del rango son inclusivos", async () => {
    const instante = FECHA_VIEJA.toISOString();

    const respuesta = await consultar(comercioA.cookie, {
      desde: instante,
      hasta: instante,
    });

    expect(respuesta.body.paginacion.total).toBe(2);
  });

  test("un rango con offset se interpreta en esa zona", async () => {
    // 2020-01-15 09:00 en Argentina es exactamente FECHA_VIEJA en UTC.
    const incluye = await consultar(comercioA.cookie, {
      desde: "2020-01-15T09:00:00-03:00",
      hasta: "2020-01-15T09:00:00-03:00",
    });
    expect(incluye.body.paginacion.total).toBe(2);

    // Un minuto antes, en la misma zona, ya no la alcanza.
    const excluye = await consultar(comercioA.cookie, {
      hasta: "2020-01-15T08:59:00-03:00",
    });
    expect(excluye.body.paginacion.total).toBe(0);
  });
});

describe("Filtros combinados", () => {
  test("producto + tipo", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "venta",
    });

    expect(idsDe(respuesta)).toEqual([libro.ventaYerba]);
  });

  test("tipo + proveedor + ubicación", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      tipo: "compra",
      proveedorId: PROVEEDOR_Y,
      ubicacionId: depositoId,
    });

    expect(idsDe(respuesta)).toEqual([libro.compraYerbaYDeposito]);
  });

  test("producto + tipo + rango de fechas", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      productoId: yerba.id,
      tipo: "ajuste",
      hasta: "2020-12-31T23:59:59.999Z",
    });

    expect(idsDe(respuesta)).toEqual([libro.altaYerba]);
  });

  test("filtros que no coinciden en ningún movimiento dan una lista vacía", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      productoId: fideos.id,
      tipo: "compra",
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.movimientos).toEqual([]);
    expect(respuesta.body.paginacion).toEqual({
      pagina: 1,
      limite: 50,
      total: 0,
      totalPaginas: 0,
    });
  });
});

describe("Paginación", () => {
  test("parte el libro en páginas sin repetir ni perder movimientos", async () => {
    const primera = await consultar(comercioA.cookie, { limite: 4, pagina: 1 });
    const segunda = await consultar(comercioA.cookie, { limite: 4, pagina: 2 });

    expect(primera.body.movimientos).toHaveLength(4);
    expect(segunda.body.movimientos).toHaveLength(2);
    expect(primera.body.paginacion.totalPaginas).toBe(2);

    const todos = [...idsDe(primera), ...idsDe(segunda)];
    expect(new Set(todos).size).toBe(6);
  });

  test("una página más allá del final da una lista vacía, no un error", async () => {
    const respuesta = await consultar(comercioA.cookie, { pagina: 99 });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.movimientos).toEqual([]);
    expect(respuesta.body.paginacion.total).toBe(6);
  });
});

describe("Aislamiento entre comercios (multi-tenant)", () => {
  test("un comercio no ve los movimientos de otro", async () => {
    const respuesta = await consultar(comercioA.cookie);
    const productos = respuesta.body.movimientos.map((m) => m.producto.id);

    expect(productos).not.toContain(libro.productoDeB);
  });

  test("filtrar por un producto de otro comercio no devuelve nada", async () => {
    const respuesta = await consultar(comercioA.cookie, {
      productoId: libro.productoDeB,
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.paginacion.total).toBe(0);
  });

  test("un comercioId en la query string se ignora", async () => {
    const respuesta = await consultar(comercioB.cookie, {
      comercioId: "123e4567-e89b-12d3-a456-426614174000",
    });

    expect(respuesta.status).toBe(200);
    // B tiene su alta y su compra: el parametro no cambio de comercio.
    expect(respuesta.body.paginacion.total).toBe(2);
  });
});

describe("Productos dados de baja", () => {
  test("su historial se sigue viendo, marcado como inactivo", async () => {
    const propietario = await registrarComercio("baja");
    const producto = await crearProducto(propietario.cookie, "Discontinuado", 5);

    const baja = await request(app)
      .delete(`/api/productos/${producto.id}`)
      .set("Cookie", propietario.cookie);
    expect(baja.status).toBeLessThan(300);

    const respuesta = await consultar(propietario.cookie, {
      productoId: producto.id,
    });

    expect(respuesta.body.paginacion.total).toBe(1);
    expect(respuesta.body.movimientos[0].producto.activo).toBe(false);
  });
});

describe("Validación de filtros", () => {
  test.each([
    [{ desde: "ayer" }, /desde/],
    [{ hasta: "2026-09-18" }, /hasta/],
    [{ desde: "2026-09-18T00:00:00Z", hasta: "2026-09-01T00:00:00Z" }, /posterior/],
    [{ tipo: "regalo" }, /tipo/],
    [{ productoId: "no-es-un-uuid" }, /productoId/],
    [{ pagina: "0" }, /pagina/],
  ])("rechaza %j con 400", async (query, mensaje) => {
    const respuesta = await consultar(comercioA.cookie, query);

    expect(respuesta.status).toBe(400);
    expect(JSON.stringify(respuesta.body)).toMatch(mensaje);
  });
});

describe("Restricciones por rol", () => {
  test("un empleado puede consultar el historial", async () => {
    const propietario = await registrarComercio("empleado");
    await crearProducto(propietario.cookie, "Algo", 3);

    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, propietario.email));

    await db
      .update(member)
      .set({ role: "empleado" })
      .where(eq(member.userId, fila.id));

    const respuesta = await consultar(propietario.cookie);

    // Auditar lo que paso en el negocio no es exclusivo del propietario: los
    // tres roles tienen `movimiento: read` (RF9).
    expect(respuesta.status).toBe(200);
    expect(respuesta.body.paginacion.total).toBe(1);
  });
});
