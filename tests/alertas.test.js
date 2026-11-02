import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { and, eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  alerta,
  comercio,
  member,
  organization,
  user,
} from "../src/db/schema.js";

/**
 * Test de integracion de HU-17 (alertas de reposicion en el dashboard).
 *
 * Corre contra la base real, igual que tests/comprasProveedor.test.js. Cada
 * caso arma su propio producto: las alertas tienen estado, y compartir un
 * producto entre tests los acoplaria por el orden en que corren.
 *
 * Lo que se prueba es el contrato HTTP y el estado en la base. El refresco del
 * panel en el navegador, su latencia y el recorrido completo desde la UI son
 * del E2E de Infraestructura (SCRUM-130).
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu17-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

const TIMEOUT_FIXTURE = 120000;

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `77902${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
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

async function crearProducto(cookie, { nombre, umbralMinimo, stockActual }) {
  const respuesta = await request(app)
    .post("/api/productos")
    .set("Cookie", cookie)
    .send({
      nombre,
      codigoBarras: codigoBarras(),
      categoria: "Almacén",
      unidadMedida: "unidad",
      umbralMinimo,
      stockActual,
    });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

async function crearProveedor(cookie, nombre) {
  const respuesta = await request(app)
    .post("/api/proveedores")
    .set("Cookie", cookie)
    .send({ nombre, telefono: "11 5555-0000" });

  expect(respuesta.status).toBe(201);
  return respuesta.body.id;
}

async function asociarProveedor(cookie, productoId, proveedorId) {
  const respuesta = await request(app)
    .post(`/api/productos/${productoId}/proveedores`)
    .set("Cookie", cookie)
    .send({ proveedorId });

  expect(respuesta.status).toBe(201);
}

function mover(cookie, datos) {
  return request(app).post("/api/movimientos").set("Cookie", cookie).send(datos);
}

async function vender(cookie, productoId, cantidad, ubicacionId) {
  const respuesta = await mover(cookie, {
    productoId,
    tipo: "venta",
    cantidad,
    ubicacionId,
  });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

async function comprar(cookie, productoId, cantidad, ubicacionId) {
  const respuesta = await mover(cookie, {
    productoId,
    tipo: "compra",
    cantidad,
    ubicacionId,
  });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

async function cambiarUmbral(cookie, productoId, umbralMinimo) {
  const respuesta = await request(app)
    .put(`/api/productos/${productoId}/umbral`)
    .set("Cookie", cookie)
    .send({ umbralMinimo });

  expect(respuesta.status).toBe(200);
  return respuesta.body;
}

function consultar(cookie, query = {}) {
  return request(app).get("/api/alertas").query(query).set("Cookie", cookie);
}

/** La alerta de un producto en la respuesta del listado, o `undefined`. */
const alertaDe = (respuesta, productoId) =>
  respuesta.body.alertas.find((a) => a.producto.id === productoId);

/** Las filas de `alerta` de un producto, para mirar lo que el listado no muestra. */
const filasDe = (productoId) =>
  db.select().from(alerta).where(eq(alerta.productoId, productoId));

let tienda;
let otraTienda;
let salonId;
let depositoId;
let proveedorSur;
let proveedorNorte;

beforeAll(async () => {
  tienda = await registrarComercio("tienda");
  otraTienda = await registrarComercio("otra");

  proveedorSur = await crearProveedor(tienda.cookie, "Distribuidora Sur");
  proveedorNorte = await crearProveedor(tienda.cookie, "Abastecedora Norte");

  // La ubicacion por defecto del comercio sale del alta de cualquier producto.
  const semilla = await crearProducto(tienda.cookie, {
    nombre: "Semilla (solo para tomar la ubicación)",
    umbralMinimo: 0,
    stockActual: 1,
  });
  salonId = semilla.stock.ubicacionId;

  const deposito = await request(app)
    .post("/api/ubicaciones")
    .set("Cookie", tienda.cookie)
    .send({ nombre: "Depósito" });
  if (deposito.status !== 201) {
    throw new Error(`No se pudo crear la ubicación: ${deposito.status}`);
  }
  depositoId = deposito.body.id;
}, TIMEOUT_FIXTURE);

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // El comercio antes que el usuario, porque `movimiento.usuario_id` es
  // `restrict`. Las alertas se van solas con el comercio (`cascade`).
  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
}, TIMEOUT_FIXTURE);

describe("GET /api/alertas — la alerta completa", () => {
  test("una venta que deja el stock bajo el umbral devuelve producto, stock, umbral, ubicaciones y proveedor", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Yerba 1 kg",
      umbralMinimo: 10,
      stockActual: 14,
    });
    await asociarProveedor(tienda.cookie, producto.id, proveedorSur);
    await vender(tienda.cookie, producto.id, 11, salonId);

    const respuesta = await consultar(tienda.cookie);
    expect(respuesta.status).toBe(200);

    const encontrada = alertaDe(respuesta, producto.id);

    expect(encontrada).toMatchObject({
      producto: {
        id: producto.id,
        nombre: "Yerba 1 kg",
        categoria: "Almacén",
        unidadMedida: "unidad",
      },
      stockActual: 3,
      umbralMinimo: 10,
      faltanteHastaElUmbral: 7,
      stockAlGenerar: 3,
      umbralAlGenerar: 10,
      ubicaciones: [{ id: salonId, cantidad: 3 }],
      proveedorSugerido: {
        id: proveedorSur,
        nombre: "Distribuidora Sur",
        telefono: "11 5555-0000",
      },
    });
    expect(encontrada.proveedores).toHaveLength(1);
    expect(typeof encontrada.generadaEn).toBe("string");
  });

  test("el desglose por ubicación suma el total del comercio, no el de una sola", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Azúcar 1 kg",
      umbralMinimo: 10,
      stockActual: 6,
    });
    await comprar(tienda.cookie, producto.id, 2, depositoId);

    // 6 en el salón + 2 en el depósito = 8, por debajo del umbral de 10.
    const encontrada = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(encontrada.stockActual).toBe(8);
    expect(encontrada.ubicaciones).toEqual(
      expect.arrayContaining([
        { id: salonId, nombre: expect.any(String), cantidad: 6 },
        { id: depositoId, nombre: "Depósito", cantidad: 2 },
      ]),
    );
  });

  test("con varios proveedores asociados, el sugerido es el primero por nombre y vienen todos", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Fideos 500 g",
      umbralMinimo: 5,
      stockActual: 8,
    });
    await asociarProveedor(tienda.cookie, producto.id, proveedorSur);
    await asociarProveedor(tienda.cookie, producto.id, proveedorNorte);
    await vender(tienda.cookie, producto.id, 4, salonId);

    const encontrada = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(encontrada.proveedores.map((p) => p.nombre)).toEqual([
      "Abastecedora Norte",
      "Distribuidora Sur",
    ]);
    expect(encontrada.proveedorSugerido.nombre).toBe("Abastecedora Norte");
  });

  test("un producto sin proveedor asociado alerta igual, con proveedorSugerido en null", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Sal fina",
      umbralMinimo: 4,
      stockActual: 9,
    });
    await vender(tienda.cookie, producto.id, 6, salonId);

    const encontrada = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(encontrada.stockActual).toBe(3);
    expect(encontrada.proveedorSugerido).toBeNull();
    expect(encontrada.proveedores).toEqual([]);
  });
});

describe("GET /api/alertas — cuándo se genera y cuándo no", () => {
  test("el saldo que queda exactamente en el umbral genera alerta", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Café 250 g",
      umbralMinimo: 10,
      stockActual: 12,
    });
    await vender(tienda.cookie, producto.id, 2, salonId);

    const encontrada = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(encontrada).toBeDefined();
    expect(encontrada.stockActual).toBe(10);
    // Llegar al mínimo ya es reponer, pero todavía no falta nada para volver.
    expect(encontrada.faltanteHastaElUmbral).toBe(0);
  });

  test("una unidad por encima del umbral no genera alerta", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Té en saquitos",
      umbralMinimo: 10,
      stockActual: 20,
    });
    await vender(tienda.cookie, producto.id, 9, salonId);

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();
    expect(await filasDe(producto.id)).toEqual([]);
  });

  test("una compra que deja el producto por debajo del umbral sí abre la alerta", async () => {
    // Stock inicial 0: el alta no registra movimiento, así que no hay alerta
    // previa y la compra es la que la abre. El panel la tiene que mostrar —el
    // faltante existe— aunque el push de HU-18 no avise por ser una entrada.
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Comprado de menos",
      umbralMinimo: 10,
      stockActual: 0,
    });

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();

    await comprar(tienda.cookie, producto.id, 2, salonId);

    const encontrada = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(encontrada).toBeDefined();
    expect(encontrada.stockActual).toBe(2);
    expect(encontrada.faltanteHastaElUmbral).toBe(8);
  });

  test("un producto con umbral 0 nunca alerta, aunque se quede sin stock", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Bolsas de papel",
      umbralMinimo: 0,
      stockActual: 5,
    });
    await vender(tienda.cookie, producto.id, 5, salonId);

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();
    expect(await filasDe(producto.id)).toEqual([]);
  });

  test("un movimiento rechazado no deja alerta: la transacción se lleva las dos cosas", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Harina 1 kg",
      umbralMinimo: 10,
      stockActual: 14,
    });

    const rechazado = await mover(tienda.cookie, {
      productoId: producto.id,
      tipo: "venta",
      cantidad: 99,
      ubicacionId: salonId,
    });

    expect(rechazado.status).toBe(409);
    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();
    expect(await filasDe(producto.id)).toEqual([]);
  });

  test("una transferencia entre ubicaciones no alerta: el total del comercio no cambia", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Arroz 1 kg",
      umbralMinimo: 10,
      stockActual: 12,
    });

    const transferencia = await request(app)
      .post("/api/transferencias")
      .set("Cookie", tienda.cookie)
      .send({
        productoId: producto.id,
        ubicacionOrigenId: salonId,
        ubicacionDestinoId: depositoId,
        cantidad: 12,
      });

    expect(transferencia.status).toBe(201);
    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();
    // Ni siquiera una resuelta: la pata de salida no evalúa, así que no llega
    // a crear una alerta que la de entrada tendría que cerrar.
    expect(await filasDe(producto.id)).toEqual([]);
  });
});

describe("GET /api/alertas — anti-duplicado y resolución", () => {
  test("dos ventas seguidas del mismo producto dejan una sola alerta", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Aceite 900 ml",
      umbralMinimo: 10,
      stockActual: 14,
    });

    await vender(tienda.cookie, producto.id, 5, salonId);
    await vender(tienda.cookie, producto.id, 3, salonId);

    const respuesta = await consultar(tienda.cookie);
    const suyas = respuesta.body.alertas.filter(
      (a) => a.producto.id === producto.id,
    );

    expect(suyas).toHaveLength(1);
    expect(await filasDe(producto.id)).toHaveLength(1);

    // El stock vivo sigue la segunda venta; la foto se queda en la primera,
    // que es cuando el producto entró en falta.
    expect(suyas[0].stockActual).toBe(6);
    expect(suyas[0].stockAlGenerar).toBe(9);
  });

  test("reponer por encima del umbral resuelve la alerta y la saca del panel", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Leche larga vida",
      umbralMinimo: 10,
      stockActual: 12,
    });

    await vender(tienda.cookie, producto.id, 5, salonId);
    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeDefined();

    await comprar(tienda.cookie, producto.id, 20, salonId);

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();

    // No se borra: queda la historia con el ciclo activa -> resuelta.
    const [fila] = await filasDe(producto.id);
    expect(fila.estado).toBe("resuelta");
    expect(fila.resueltaEn).not.toBeNull();
  });

  test("reponer hasta quedar justo en el umbral NO resuelve", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Galletitas",
      umbralMinimo: 10,
      stockActual: 12,
    });

    await vender(tienda.cookie, producto.id, 8, salonId);
    await comprar(tienda.cookie, producto.id, 6, salonId);

    const encontrada = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(encontrada).toBeDefined();
    expect(encontrada.stockActual).toBe(10);
  });

  test("después de resolver, volver a caer genera una alerta nueva", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Jabón en polvo",
      umbralMinimo: 5,
      stockActual: 6,
    });

    await vender(tienda.cookie, producto.id, 2, salonId);
    const primera = alertaDe(await consultar(tienda.cookie), producto.id);

    await comprar(tienda.cookie, producto.id, 10, salonId);
    await vender(tienda.cookie, producto.id, 12, salonId);

    const segunda = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(segunda).toBeDefined();
    // El índice único es parcial: exige unicidad solo entre las activas, así
    // que el producto puede volver a alertar sin que la resuelta estorbe.
    expect(segunda.id).not.toBe(primera.id);
    expect(await filasDe(producto.id)).toHaveLength(2);
  });
});

describe("GET /api/alertas — el umbral como segundo disparador", () => {
  test("subir el umbral de un producto ya bajo de stock genera la alerta sin ningún movimiento", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Vinagre 500 ml",
      umbralMinimo: 0,
      stockActual: 3,
    });

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();

    await cambiarUmbral(tienda.cookie, producto.id, 10);

    const encontrada = alertaDe(await consultar(tienda.cookie), producto.id);

    expect(encontrada).toBeDefined();
    expect(encontrada.stockActual).toBe(3);
    expect(encontrada.umbralMinimo).toBe(10);
  });

  test("bajar el umbral por debajo del stock resuelve la alerta activa", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Mostaza",
      umbralMinimo: 10,
      stockActual: 12,
    });

    await vender(tienda.cookie, producto.id, 4, salonId);
    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeDefined();

    await cambiarUmbral(tienda.cookie, producto.id, 3);

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();

    const [fila] = await filasDe(producto.id);
    expect(fila.estado).toBe("resuelta");
  });

  test("poner el umbral en 0 («sin umbral») también resuelve", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Ketchup",
      umbralMinimo: 10,
      stockActual: 12,
    });

    await vender(tienda.cookie, producto.id, 4, salonId);
    await cambiarUmbral(tienda.cookie, producto.id, 0);

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();
  });
});

describe("GET /api/alertas — aislamiento, orden y paginación", () => {
  test("las alertas de otro comercio no se ven", async () => {
    const ajeno = await crearProducto(otraTienda.cookie, {
      nombre: "Producto del otro comercio",
      umbralMinimo: 10,
      stockActual: 12,
    });
    const ubicacionAjena = ajeno.stock.ubicacionId;
    await vender(otraTienda.cookie, ajeno.id, 5, ubicacionAjena);

    // El dueño sí la ve.
    expect(alertaDe(await consultar(otraTienda.cookie), ajeno.id)).toBeDefined();

    const respuesta = await consultar(tienda.cookie);

    expect(alertaDe(respuesta, ajeno.id)).toBeUndefined();
    expect(
      respuesta.body.alertas.every((a) => a.producto.id !== ajeno.id),
    ).toBe(true);
  });

  test("un producto dado de baja no aparece aunque su alerta siga activa", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Producto a dar de baja",
      umbralMinimo: 10,
      stockActual: 12,
    });
    await vender(tienda.cookie, producto.id, 5, salonId);
    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeDefined();

    const baja = await request(app)
      .delete(`/api/productos/${producto.id}`)
      .set("Cookie", tienda.cookie);
    expect(baja.status).toBe(204);

    expect(alertaDe(await consultar(tienda.cookie), producto.id)).toBeUndefined();

    // La fila sigue activa en la base: el borrado lógico no es una resolución.
    const [fila] = await filasDe(producto.id);
    expect(fila.estado).toBe("activa");
  });

  test("primero las más urgentes: el que está más lejos de su umbral", async () => {
    const otro = await registrarComercio("orden");
    const semilla = await crearProducto(otro.cookie, {
      nombre: "Semilla orden",
      umbralMinimo: 0,
      stockActual: 1,
    });
    const ubicacion = semilla.stock.ubicacionId;

    // Faltante 1.
    const cerca = await crearProducto(otro.cookie, {
      nombre: "Cerca del umbral",
      umbralMinimo: 10,
      stockActual: 12,
    });
    await vender(otro.cookie, cerca.id, 3, ubicacion);

    // Faltante 9.
    const lejos = await crearProducto(otro.cookie, {
      nombre: "Lejos del umbral",
      umbralMinimo: 10,
      stockActual: 12,
    });
    await vender(otro.cookie, lejos.id, 11, ubicacion);

    const respuesta = await consultar(otro.cookie);

    expect(respuesta.body.alertas.map((a) => a.producto.nombre)).toEqual([
      "Lejos del umbral",
      "Cerca del umbral",
    ]);
    expect(respuesta.body.alertas.map((a) => a.faltanteHastaElUmbral)).toEqual([
      9, 1,
    ]);
  }, TIMEOUT_FIXTURE);

  test("la paginación no repite ni saltea filas", async () => {
    const respuesta = await consultar(tienda.cookie, { limite: 200 });
    const total = respuesta.body.paginacion.total;

    expect(total).toBe(respuesta.body.alertas.length);
    expect(total).toBeGreaterThan(1);

    const primera = await consultar(tienda.cookie, { limite: 1, pagina: 1 });
    const segunda = await consultar(tienda.cookie, { limite: 1, pagina: 2 });

    expect(primera.body.paginacion).toEqual({
      pagina: 1,
      limite: 1,
      total,
      totalPaginas: total,
    });
    expect(primera.body.alertas).toHaveLength(1);
    expect(segunda.body.alertas).toHaveLength(1);
    expect(segunda.body.alertas[0].id).not.toBe(primera.body.alertas[0].id);

    // Las dos primeras de la página completa, en el mismo orden.
    expect([primera.body.alertas[0].id, segunda.body.alertas[0].id]).toEqual(
      respuesta.body.alertas.slice(0, 2).map((a) => a.id),
    );
  });
});

describe("GET /api/alertas — errores", () => {
  test("sin sesión responde 401", async () => {
    const respuesta = await request(app).get("/api/alertas");

    expect(respuesta.status).toBe(401);
    expect(respuesta.body).toEqual({ error: "No hay sesion activa" });
  });

  test("pagina 0 responde 400 con el formato de error de la API", async () => {
    const respuesta = await consultar(tienda.cookie, { pagina: 0 });

    expect(respuesta.status).toBe(400);
    expect(typeof respuesta.body.error).toBe("string");
  });

  test("un limite que no es un entero responde 400", async () => {
    expect((await consultar(tienda.cookie, { limite: "abc" })).status).toBe(400);
  });

  test("un limite mayor al máximo se recorta en vez de fallar", async () => {
    const respuesta = await consultar(tienda.cookie, { limite: 5000 });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.paginacion.limite).toBe(200);
  });
});

describe("La tabla alerta", () => {
  test("guarda el movimiento que la disparó, y lo deja en null cuando la disparó el umbral", async () => {
    const porMovimiento = await crearProducto(tienda.cookie, {
      nombre: "Disparada por venta",
      umbralMinimo: 10,
      stockActual: 12,
    });
    const venta = await vender(tienda.cookie, porMovimiento.id, 5, salonId);

    const [filaMovimiento] = await filasDe(porMovimiento.id);
    expect(filaMovimiento.movimientoId).toBe(venta.movimiento.id);

    const porUmbral = await crearProducto(tienda.cookie, {
      nombre: "Disparada por umbral",
      umbralMinimo: 0,
      stockActual: 2,
    });
    await cambiarUmbral(tienda.cookie, porUmbral.id, 10);

    const [filaUmbral] = await filasDe(porUmbral.id);
    expect(filaUmbral.movimientoId).toBeNull();
  });

  test("el índice único parcial impide una segunda alerta activa del mismo producto", async () => {
    const producto = await crearProducto(tienda.cookie, {
      nombre: "Doble alerta imposible",
      umbralMinimo: 10,
      stockActual: 12,
    });
    await vender(tienda.cookie, producto.id, 5, salonId);

    const [fila] = await filasDe(producto.id);

    // Insertar a mano, salteando el service: lo que tiene que frenar esto es
    // la base, no el código. Si el índice se cayera, el anti-duplicado del
    // panel y del push de HU-18 se caen con él.
    await expect(
      db.insert(alerta).values({
        comercioId: fila.comercioId,
        productoId: producto.id,
        stockAlGenerar: 1,
        umbralAlGenerar: 10,
      }),
    ).rejects.toThrow();

    const activas = await db
      .select()
      .from(alerta)
      .where(
        and(eq(alerta.productoId, producto.id), eq(alerta.estado, "activa")),
      );

    expect(activas).toHaveLength(1);
  });
});
