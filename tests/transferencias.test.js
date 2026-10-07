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
  transferencia,
  user,
} from "../src/db/schema.js";

/**
 * Test de integracion de HU-12 (transferencia de stock entre ubicaciones).
 *
 * Corre contra la base real, como el resto de los tests de stock: lo que se
 * verifica es la transaccion —las dos patas del libro y las dos filas de
 * stock, todo o nada—, el rechazo por stock insuficiente y el filtrado por
 * `comercio_id`, y ninguna de las tres tiene sentido sin datos y sesiones de
 * verdad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu12-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

/** Maximo de un integer de Postgres, el tope de `stock.cantidad`. */
const CANTIDAD_MAXIMA = 2147483647;

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

async function crearUbicacion(cookie, nombre) {
  const respuesta = await request(app)
    .post("/api/ubicaciones")
    .set("Cookie", cookie)
    .send({ nombre });

  expect(respuesta.status).toBe(201);
  return respuesta.body.id;
}

/** Crea un producto con su stock inicial en la ubicacion indicada. */
async function crearProducto(cookie, ubicacionId, stockActual = 20) {
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
      ubicacionId,
    });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

async function transferir(cookie, datos) {
  return request(app)
    .post("/api/transferencias")
    .set("Cookie", cookie)
    .send(datos);
}

/**
 * Saldo cacheado de un producto en una ubicacion, directo de la base.
 * Devuelve `null` cuando todavia no hay fila, que no es lo mismo que 0.
 */
async function leerStock(productoId, ubicacionId) {
  const [fila] = await db
    .select({ cantidad: stock.cantidad })
    .from(stock)
    .where(
      and(eq(stock.productoId, productoId), eq(stock.ubicacionId, ubicacionId)),
    );

  return fila?.cantidad ?? null;
}

async function contarMovimientos(productoId) {
  const [fila] = await db
    .select({ c: sql`count(*)::int` })
    .from(movimiento)
    .where(eq(movimiento.productoId, productoId));

  return fila.c;
}

async function contarTransferencias(comercioId) {
  const [fila] = await db
    .select({ c: sql`count(*)::int` })
    .from(transferencia)
    .where(eq(transferencia.comercioId, comercioId));

  return fila.c;
}

async function comercioIdDe(email) {
  const [fila] = await db
    .select({ id: comercio.id })
    .from(comercio)
    .innerJoin(member, eq(member.organizationId, comercio.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(user.email, email));

  return fila.id;
}

let propietarioA;
let propietarioB;
let comercioIdA;
let deposito;
let local;
let ubicacionDeB;

beforeAll(async () => {
  propietarioA = await registrarComercio("a");
  propietarioB = await registrarComercio("b");

  comercioIdA = await comercioIdDe(propietarioA.email);

  deposito = await crearUbicacion(propietarioA.cookie, "Depósito");
  local = await crearUbicacion(propietarioA.cookie, "Local");
  ubicacionDeB = await crearUbicacion(propietarioB.cookie, "Sucursal");
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // El comercio va primero, antes que el usuario: `movimiento.usuario_id` y
  // `transferencia.usuario_id` son `onDelete: restrict`, asi que borrar un
  // usuario que transfirio falla mientras esas filas existan. Borrar el
  // comercio se las lleva por cascada.
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
  test("no se puede transferir", async () => {
    const respuesta = await request(app).post("/api/transferencias").send({
      productoId: "123e4567-e89b-12d3-a456-426614174000",
      ubicacionOrigenId: "223e4567-e89b-12d3-a456-426614174001",
      ubicacionDestinoId: "323e4567-e89b-12d3-a456-426614174002",
      cantidad: 1,
    });

    expect(respuesta.status).toBe(401);
  });
});

describe("Transferencia exitosa", () => {
  test("descuenta del origen y suma al destino en una sola operación", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 20);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 8,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.stock.origen.cantidad).toBe(12);
    expect(respuesta.body.stock.destino.cantidad).toBe(8);

    expect(await leerStock(producto.id, deposito)).toBe(12);
    expect(await leerStock(producto.id, local)).toBe(8);
  });

  test("el total del producto no cambia: la mercadería se movió, no apareció", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 20);

    await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 7,
    });

    const respuesta = await request(app)
      .get(`/api/productos/${producto.id}`)
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.stock.total).toBe(20);

    const porUbicacion = Object.fromEntries(
      respuesta.body.stock.porUbicacion.map((f) => [f.ubicacionId, f.cantidad]),
    );
    expect(porUbicacion[deposito]).toBe(13);
    expect(porUbicacion[local]).toBe(7);
  });

  test("si el destino no tenía stock del producto, la fila se crea con lo transferido", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    // El alta solo crea la fila de la ubicacion elegida: en el local no hay
    // ninguna fila de este producto todavia.
    expect(await leerStock(producto.id, local)).toBeNull();

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 4,
    });

    expect(respuesta.status).toBe(201);
    expect(await leerStock(producto.id, local)).toBe(4);
  });

  test("transferir exactamente todo lo disponible deja el origen en cero", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 6);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 6,
    });

    expect(respuesta.status).toBe(201);
    expect(await leerStock(producto.id, deposito)).toBe(0);
  });
});

describe("El par de movimientos ligados", () => {
  test("crea dos movimientos con el mismo transferenciaId, uno negativo y uno positivo", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 15);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 5,
      motivo: "Reposición de góndola",
    });

    expect(respuesta.status).toBe(201);

    const [salida, entrada] = respuesta.body.movimientos;

    expect(respuesta.body.movimientos).toHaveLength(2);
    expect(salida.transferenciaId).toBe(respuesta.body.transferencia.id);
    expect(entrada.transferenciaId).toBe(respuesta.body.transferencia.id);

    expect(salida.tipo).toBe("transferencia");
    expect(entrada.tipo).toBe("transferencia");

    expect(salida.cantidad).toBe(-5);
    expect(entrada.cantidad).toBe(5);

    expect(salida.ubicacionId).toBe(deposito);
    expect(entrada.ubicacionId).toBe(local);
  });

  test("el encabezado guarda origen, destino, quién y el motivo", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 15);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 3,
      motivo: "  Reposición de góndola  ",
    });

    expect(respuesta.body.transferencia.ubicacionOrigenId).toBe(deposito);
    expect(respuesta.body.transferencia.ubicacionDestinoId).toBe(local);
    expect(respuesta.body.transferencia.usuarioId).toEqual(expect.any(String));
    expect(respuesta.body.transferencia.motivo).toBe("Reposición de góndola");
  });

  test("el proveedor no aplica: las dos patas quedan sin proveedorId", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 15);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 2,
      // Aunque el cliente lo mande, no se guarda: no hay contraparte externa.
      proveedorId: "423e4567-e89b-12d3-a456-426614174003",
    });

    expect(respuesta.body.movimientos[0].proveedorId).toBeNull();
    expect(respuesta.body.movimientos[1].proveedorId).toBeNull();
  });

  test("las dos patas aparecen en el historial de movimientos (HU-14)", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 15);

    const hecha = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 5,
    });

    const historial = await request(app)
      .get(`/api/movimientos?productoId=${producto.id}&tipo=transferencia`)
      .set("Cookie", propietarioA.cookie);

    expect(historial.status).toBe(200);
    expect(historial.body.movimientos).toHaveLength(2);

    const ids = new Set(
      historial.body.movimientos.map((m) => m.transferenciaId),
    );
    expect([...ids]).toEqual([hecha.body.transferencia.id]);
  });
});

describe("Stock insuficiente", () => {
  test("no se puede transferir más de lo disponible en el origen", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 5);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 6,
    });

    expect(respuesta.status).toBe(409);
    expect(respuesta.body.error).toMatch(/Stock insuficiente/i);
  });

  test("el rechazo no deja rastro: ni movimientos, ni transferencia, ni saldos tocados", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 5);

    const movimientosAntes = await contarMovimientos(producto.id);
    const transferenciasAntes = await contarTransferencias(comercioIdA);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 6,
    });

    expect(respuesta.status).toBe(409);
    expect(await contarMovimientos(producto.id)).toBe(movimientosAntes);
    expect(await contarTransferencias(comercioIdA)).toBe(transferenciasAntes);
    expect(await leerStock(producto.id, deposito)).toBe(5);
    expect(await leerStock(producto.id, local)).toBeNull();
  });

  test("un producto sin stock en el origen no se puede transferir", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 0);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(409);
  });
});

describe("Atomicidad: o pasa todo o no pasa nada", () => {
  /**
   * Falla la SEGUNDA pata, con la primera ya aplicada dentro de la
   * transaccion: se lleva el destino al tope de un integer con una compra, y
   * despues se transfiere una unidad. La salida del origen pasa sin problema;
   * la entrada al destino se rechaza porque el saldo resultante no entra en la
   * columna. Si la transferencia no fuera una sola transaccion, el origen
   * quedaria descontado y esas unidades desaparecerian del inventario.
   *
   * Es un error real de la logica, no un mock: este repo no mockea modulos en
   * ningun lado.
   */
  test("si la segunda pata falla, la primera se revierte y no se pierde mercadería", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 5);

    const compra = await request(app)
      .post("/api/movimientos")
      .set("Cookie", propietarioA.cookie)
      .send({
        productoId: producto.id,
        tipo: "compra",
        cantidad: CANTIDAD_MAXIMA,
        ubicacionId: local,
      });

    expect(compra.status).toBe(201);
    expect(await leerStock(producto.id, local)).toBe(CANTIDAD_MAXIMA);

    const movimientosAntes = await contarMovimientos(producto.id);
    const transferenciasAntes = await contarTransferencias(comercioIdA);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(409);

    // Lo que importa: el origen quedo intacto.
    expect(await leerStock(producto.id, deposito)).toBe(5);
    expect(await leerStock(producto.id, local)).toBe(CANTIDAD_MAXIMA);
    expect(await contarMovimientos(producto.id)).toBe(movimientosAntes);
    expect(await contarTransferencias(comercioIdA)).toBe(transferenciasAntes);
  });
});

describe("Validaciones", () => {
  test("origen y destino no pueden ser la misma ubicación", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: deposito,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/distintas/i);
  });

  // Regresion: el mismo id en otra capitalizacion pasaba la validacion, y el
  // CHECK de la tabla cortaba el INSERT con un 500. Tiene que ser el mismo 400.
  test("la misma ubicación en mayúsculas cuenta como la misma, y da 400 y no 500", async () => {
    // Sin letras en el id, `toUpperCase()` no cambiaria nada y el test pasaria
    // sin probar el caso. Improbable con un UUID aleatorio, pero no imposible.
    expect(deposito.toUpperCase()).not.toBe(deposito);

    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: deposito.toUpperCase(),
      cantidad: 1,
    });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/distintas/i);
  });

  test("ids en mayúsculas de ubicaciones distintas funcionan igual", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id.toUpperCase(),
      ubicacionOrigenId: deposito.toUpperCase(),
      ubicacionDestinoId: local.toUpperCase(),
      cantidad: 3,
    });

    expect(respuesta.status).toBe(201);
    expect(await leerStock(producto.id, local)).toBe(3);
  });

  test("falta la ubicación de destino", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(400);
  });

  test.each([
    ["cero", 0],
    ["negativa", -1],
    ["decimal", 2.5],
    ["como cadena", "3"],
  ])("una cantidad %s se rechaza con 400", async (_etiqueta, cantidad) => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad,
    });

    expect(respuesta.status).toBe(400);
  });

  test("un producto dado de baja no se puede transferir", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const baja = await request(app)
      .delete(`/api/productos/${producto.id}`)
      .set("Cookie", propietarioA.cookie);

    expect(baja.status).toBe(204);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(404);
  });
});

describe("Aislamiento entre comercios (multi-tenant)", () => {
  test("no se puede transferir un producto de otro comercio", async () => {
    const ajeno = await crearProducto(propietarioB.cookie, ubicacionDeB, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: ajeno.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(404);
    expect(respuesta.body.error).toMatch(/producto/i);
  });

  test("no se puede usar una ubicación de otro comercio como destino", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: ubicacionDeB,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(404);
    expect(respuesta.body.error).toMatch(/ubicación/i);
  });

  test("no se puede usar una ubicación de otro comercio como origen", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const respuesta = await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: ubicacionDeB,
      ubicacionDestinoId: local,
      cantidad: 1,
    });

    expect(respuesta.status).toBe(404);
  });
});

describe("Concurrencia", () => {
  test("dos transferencias simultáneas de las últimas unidades: una pasa y la otra se rechaza", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    const cuerpo = {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 6,
    };

    const [una, otra] = await Promise.all([
      transferir(propietarioA.cookie, cuerpo),
      transferir(propietarioA.cookie, cuerpo),
    ]);

    expect([una.status, otra.status].sort()).toEqual([201, 409]);

    // Lo importante: el stock nunca queda negativo.
    expect(await leerStock(producto.id, deposito)).toBe(4);
    expect(await leerStock(producto.id, local)).toBe(6);
  });

  test("dos transferencias en sentidos opuestos no terminan en un 500 por deadlock", async () => {
    const producto = await crearProducto(propietarioA.cookie, deposito, 10);

    // Deja saldo en las dos puntas, para que las dos transferencias toquen las
    // mismas dos filas de stock.
    await transferir(propietarioA.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: deposito,
      ubicacionDestinoId: local,
      cantidad: 5,
    });

    const [ida, vuelta] = await Promise.all([
      transferir(propietarioA.cookie, {
        productoId: producto.id,
        ubicacionOrigenId: deposito,
        ubicacionDestinoId: local,
        cantidad: 2,
      }),
      transferir(propietarioA.cookie, {
        productoId: producto.id,
        ubicacionOrigenId: local,
        ubicacionDestinoId: deposito,
        cantidad: 2,
      }),
    ]);

    expect(ida.status).toBe(201);
    expect(vuelta.status).toBe(201);

    // El total se conserva: las dos se aplicaron enteras.
    const enDeposito = await leerStock(producto.id, deposito);
    const enLocal = await leerStock(producto.id, local);
    expect(enDeposito + enLocal).toBe(10);
  });
});

describe("Restricciones por rol", () => {
  // Los tres roles tienen `transferencia: ["create"]` (HU-32), asi que no hay
  // ningun rol que deba recibir 403 acá: no es un caso que falte, es que no
  // existe. La matriz completa por rol esta en controlAcceso.test.js.
  test("un empleado puede transferir", async () => {
    const empleado = await registrarComercio("empleado");
    const origen = await crearUbicacion(empleado.cookie, "Depósito");
    const destino = await crearUbicacion(empleado.cookie, "Local");
    const producto = await crearProducto(empleado.cookie, origen, 10);

    const [fila] = await db
      .select({ userId: user.id })
      .from(user)
      .where(eq(user.email, empleado.email));

    await db
      .update(member)
      .set({ role: "empleado" })
      .where(eq(member.userId, fila.userId));

    const respuesta = await transferir(empleado.cookie, {
      productoId: producto.id,
      ubicacionOrigenId: origen,
      ubicacionDestinoId: destino,
      cantidad: 3,
    });

    expect(respuesta.status).toBe(201);
  });
});
