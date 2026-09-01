import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  comercio,
  member,
  movimiento,
  organization,
  stock,
  user,
} from "../src/db/schema.js";

/**
 * Test de integracion de HU-13 (registro de movimiento de entrada/salida).
 *
 * Corre contra la base real, igual que tests/productos.test.js: lo que se
 * verifica es la transaccion movimiento+stock, la validacion de stock
 * insuficiente y el filtrado por `comercio_id`, y ninguna de las tres tiene
 * sentido sin datos y sesiones de verdad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu13-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `78900${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
}

/** Registra un comercio nuevo y devuelve su cookie de sesion. */
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

/** Crea un producto con el stock inicial indicado y devuelve el body. */
async function crearProducto(cookie, stockActual = 20, overrides = {}) {
  const respuesta = await request(app)
    .post("/api/productos")
    .set("Cookie", cookie)
    .send({
      nombre: "Producto de prueba",
      codigoBarras: codigoBarras(),
      categoria: "Bebidas",
      unidadMedida: "unidad",
      umbralMinimo: 5,
      stockActual,
      ...overrides,
    });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

async function registrarMovimiento(cookie, datos) {
  return request(app).post("/api/movimientos").set("Cookie", cookie).send(datos);
}

/** Lee el saldo cacheado de una fila de stock, directo de la base. */
async function leerStock(stockId) {
  const [fila] = await db
    .select({ cantidad: stock.cantidad })
    .from(stock)
    .where(eq(stock.id, stockId));

  return fila.cantidad;
}

async function contarMovimientos(productoId) {
  const [fila] = await db
    .select({ c: sql`count(*)::int` })
    .from(movimiento)
    .where(eq(movimiento.productoId, productoId));

  return fila.c;
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

  // El comercio va primero, antes que el usuario: `movimiento.usuario_id` es
  // `onDelete: restrict`, asi que borrar un usuario que registro movimientos
  // falla mientras esas filas existan. Borrar el comercio se las lleva por
  // cascada junto con `producto`, `ubicacion` y `stock`.
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
  test("no se puede registrar un movimiento", async () => {
    const respuesta = await request(app)
      .post("/api/movimientos")
      .send({ productoId: "123e4567-e89b-12d3-a456-426614174000", tipo: "venta", cantidad: 1 });

    expect(respuesta.status).toBe(401);
  });
});

describe("Entradas y salidas", () => {
  test("una compra suma al stock y guarda la cantidad en positivo", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "compra",
      cantidad: 10,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.movimiento.cantidad).toBe(10);
    expect(respuesta.body.movimiento.tipo).toBe("compra");
    expect(respuesta.body.stock.cantidad).toBe(30);
    expect(await leerStock(producto.stock.id)).toBe(30);
  });

  test("una venta resta del stock y guarda la cantidad en negativo", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 3,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.movimiento.cantidad).toBe(-3);
    expect(respuesta.body.stock.cantidad).toBe(17);
    expect(await leerStock(producto.stock.id)).toBe(17);
  });

  test("una merma resta igual que una venta", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "merma",
      cantidad: 2,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.movimiento.cantidad).toBe(-2);
    expect(respuesta.body.stock.cantidad).toBe(18);
  });

  test("un ajuste suma o resta según el sentido", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const suma = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "ajuste",
      cantidad: 5,
      sentido: "entrada",
    });
    expect(suma.status).toBe(201);
    expect(suma.body.stock.cantidad).toBe(25);

    const resta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "ajuste",
      cantidad: 5,
      sentido: "salida",
    });
    expect(resta.status).toBe(201);
    expect(resta.body.stock.cantidad).toBe(20);
  });

  test("el movimiento registra fecha, usuario y proveedor asociado", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);
    const proveedorId = "123e4567-e89b-12d3-a456-426614174999";

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "compra",
      cantidad: 4,
      proveedorId,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.movimiento.fecha).toBeTruthy();
    expect(respuesta.body.movimiento.usuarioId).toBeTruthy();
    expect(respuesta.body.movimiento.productoId).toBe(producto.id);
    // Se persiste sin validar contra PROVEEDOR: esa tabla la crea HU-19.
    expect(respuesta.body.movimiento.proveedorId).toBe(proveedorId);
  });
});

describe("Stock insuficiente", () => {
  test("no permite descontar más de lo disponible y no cambia nada", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);
    const movimientosAntes = await contarMovimientos(producto.id);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 999,
    });

    expect(respuesta.status).toBe(409);
    expect(respuesta.body.error).toMatch(/stock insuficiente/i);

    // Lo que prueba la atomicidad: el rechazo no dejo rastro de ningun lado.
    expect(await leerStock(producto.stock.id)).toBe(20);
    expect(await contarMovimientos(producto.id)).toBe(movimientosAntes);
  });

  test("descontar exactamente lo disponible sí se permite y deja el stock en 0", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 20,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.stock.cantidad).toBe(0);
  });

  test("con el stock ya en 0, cualquier salida se rechaza", async () => {
    const producto = await crearProducto(propietarioA.cookie, 0);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
    });

    expect(respuesta.status).toBe(409);
  });

  test("un ajuste de salida también respeta el límite", async () => {
    const producto = await crearProducto(propietarioA.cookie, 5);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "ajuste",
      cantidad: 6,
      sentido: "salida",
    });

    expect(respuesta.status).toBe(409);
    expect(await leerStock(producto.stock.id)).toBe(5);
  });

  test("dos ventas simultáneas de las últimas unidades no dejan el stock en negativo", async () => {
    const producto = await crearProducto(propietarioA.cookie, 10);

    const [una, otra] = await Promise.all([
      registrarMovimiento(propietarioA.cookie, {
        productoId: producto.id,
        tipo: "venta",
        cantidad: 10,
      }),
      registrarMovimiento(propietarioA.cookie, {
        productoId: producto.id,
        tipo: "venta",
        cantidad: 10,
      }),
    ]);

    expect([una.status, otra.status].sort()).toEqual([201, 409]);
    expect(await leerStock(producto.stock.id)).toBe(0);
  });
});

describe("Validación del cuerpo", () => {
  test.each([
    ["tipo inexistente", { tipo: "devolucion" }],
    ["tipo transferencia (lo crea HU-12)", { tipo: "transferencia" }],
    ["cantidad en cero", { cantidad: 0 }],
    ["cantidad negativa", { cantidad: -5 }],
    ["cantidad decimal", { cantidad: 1.5 }],
    ["ajuste sin sentido", { tipo: "ajuste" }],
  ])("rechaza con 400: %s", async (_caso, override) => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 3,
      ...override,
    });

    expect(respuesta.status).toBe(400);
  });
});

describe("Aislamiento entre comercios (multi-tenant)", () => {
  test("no se puede mover el stock de un producto de otro comercio", async () => {
    const deB = await crearProducto(propietarioB.cookie, 20);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: deB.id,
      tipo: "venta",
      cantidad: 1,
    });

    expect(respuesta.status).toBe(404);
    expect(await leerStock(deB.stock.id)).toBe(20);
  });

  test("un producto inexistente o con id mal formado da 404", async () => {
    const inexistente = await registrarMovimiento(propietarioA.cookie, {
      productoId: "123e4567-e89b-12d3-a456-426614174000",
      tipo: "venta",
      cantidad: 1,
    });
    expect(inexistente.status).toBe(404);

    const malFormado = await registrarMovimiento(propietarioA.cookie, {
      productoId: "no-es-un-uuid",
      tipo: "venta",
      cantidad: 1,
    });
    expect(malFormado.status).toBe(400);
  });

  test("no se puede mover stock de un producto dado de baja", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    await request(app)
      .delete(`/api/productos/${producto.id}`)
      .set("Cookie", propietarioA.cookie);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
    });

    expect(respuesta.status).toBe(404);
  });

  test("no se puede usar una ubicación de otro comercio", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const ubicacionDeB = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioB.cookie)
      .send({ nombre: `Depósito ajeno ${SUFIJO}` });
    expect(ubicacionDeB.status).toBe(201);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
      ubicacionId: ubicacionDeB.body.id,
    });

    expect(respuesta.status).toBe(404);
  });

  test("un comercioId en el body se ignora: se graba el de la sesión", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const respuesta = await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
      comercioId: "123e4567-e89b-12d3-a456-426614174000",
    });

    expect(respuesta.status).toBe(201);

    const [filaComercio] = await db
      .select({ comercioId: comercio.id })
      .from(comercio)
      .innerJoin(organization, eq(organization.id, comercio.organizationId))
      .innerJoin(member, eq(member.organizationId, organization.id))
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, propietarioA.email));

    expect(respuesta.body.movimiento.comercioId).toBe(filaComercio.comercioId);
  });
});

describe("Resolución de la ubicación", () => {
  test("con una sola ubicación no hace falta mandarla (RNF1)", async () => {
    const propietario = await registrarComercio("una-ubicacion");
    const producto = await crearProducto(propietario.cookie, 20);

    const respuesta = await registrarMovimiento(propietario.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.stock.ubicacionId).toBe(producto.stock.ubicacionId);
  });

  test("con más de una ubicación es obligatoria", async () => {
    const propietario = await registrarComercio("dos-ubicaciones");
    const producto = await crearProducto(propietario.cookie, 20);

    await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietario.cookie)
      .send({ nombre: "Depósito" });

    const sinUbicacion = await registrarMovimiento(propietario.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
    });
    expect(sinUbicacion.status).toBe(400);

    const conUbicacion = await registrarMovimiento(propietario.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
      ubicacionId: producto.stock.ubicacionId,
    });
    expect(conUbicacion.status).toBe(201);
  });

  test("el stock se lleva por ubicación: mover en una no toca la otra", async () => {
    const propietario = await registrarComercio("stock-por-ubicacion");
    const producto = await crearProducto(propietario.cookie, 20);

    const otra = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietario.cookie)
      .send({ nombre: "Depósito" });

    const enLaOtra = await registrarMovimiento(propietario.cookie, {
      productoId: producto.id,
      tipo: "compra",
      cantidad: 7,
      ubicacionId: otra.body.id,
    });

    expect(enLaOtra.status).toBe(201);
    // Fila de stock nueva para la ubicacion nueva, con su propio saldo.
    expect(enLaOtra.body.stock.cantidad).toBe(7);
    expect(enLaOtra.body.stock.id).not.toBe(producto.stock.id);
    expect(await leerStock(producto.stock.id)).toBe(20);
  });
});

describe("Restricciones por rol", () => {
  test("un empleado sí puede registrar movimientos", async () => {
    const propietario = await registrarComercio("empleado");
    const producto = await crearProducto(propietario.cookie, 20);

    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, propietario.email));

    await db
      .update(member)
      .set({ role: "empleado" })
      .where(eq(member.userId, fila.id));

    const respuesta = await registrarMovimiento(propietario.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 1,
    });

    // A diferencia de productos, los tres roles pueden crear movimientos:
    // registrar una venta es justamente la tarea del empleado (RF9).
    expect(respuesta.status).toBe(201);
  });
});

describe("Invariante del modelo híbrido", () => {
  test("el stock cacheado siempre coincide con la suma del libro", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "compra",
      cantidad: 15,
    });
    await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 4,
    });
    await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "merma",
      cantidad: 1,
    });
    await registrarMovimiento(propietarioA.cookie, {
      productoId: producto.id,
      tipo: "ajuste",
      cantidad: 2,
      sentido: "salida",
    });

    const [libro] = await db
      .select({ total: sql`coalesce(sum(${movimiento.cantidad}), 0)::int` })
      .from(movimiento)
      .where(
        and(
          eq(movimiento.productoId, producto.id),
          eq(movimiento.ubicacionId, producto.stock.ubicacionId),
        ),
      );

    // 20 (alta) + 15 - 4 - 1 - 2
    expect(libro.total).toBe(28);
    expect(await leerStock(producto.stock.id)).toBe(libro.total);
  });

  test("el stock inicial del alta de un producto queda respaldado por su movimiento", async () => {
    const producto = await crearProducto(propietarioA.cookie, 20);

    const movimientos = await db
      .select({ tipo: movimiento.tipo, cantidad: movimiento.cantidad })
      .from(movimiento)
      .where(eq(movimiento.productoId, producto.id));

    expect(movimientos).toEqual([{ tipo: "ajuste", cantidad: 20 }]);
  });

  test("un alta con stock inicial 0 crea la fila de stock pero ningún movimiento", async () => {
    const producto = await crearProducto(propietarioA.cookie, 0);

    expect(producto.stock.cantidad).toBe(0);
    expect(await contarMovimientos(producto.id)).toBe(0);
  });
});
