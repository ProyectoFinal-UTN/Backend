import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  comercio,
  member,
  movimiento,
  organization,
  producto,
  proveedor,
  stock,
  user,
} from "../src/db/schema.js";
import {
  DIAS_POR_DEFECTO,
  LIMITE_MAS_VENDIDOS,
  limpiarCacheDeKpis,
  ventanaDeDias,
} from "../src/services/kpis.service.js";

/**
 * Test de integracion de HU-22 (KPIs principales del dashboard).
 *
 * Corre contra la base real, igual que tests/comprasProveedor.test.js. Tres
 * partes, que son las de la subtarea de Testing (SCRUM-142):
 *
 * 1. Exactitud: un comercio con un libro chico y conocido, donde cada numero
 *    del dashboard se puede calcular a mano (ver el comentario del fixture).
 * 2. Aislamiento: otro comercio con su propia actividad, que no puede aparecer
 *    en los KPIs del primero ni al reves.
 * 3. Rendimiento (RNF2): un tercer comercio con un volumen realista de
 *    movimientos, donde la carga en frio tiene que tardar menos de 2 segundos.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu22-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

const DIA_MS = 24 * 60 * 60 * 1000;
const haceDias = (dias) => new Date(Date.now() - dias * DIA_MS);

/** Lo que pide el criterio de aceptacion de RNF2. */
const TOPE_DE_CARGA_MS = 2000;

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `77922${Date.now().toString().slice(-5)}${contadorCodigo}`.slice(0, 13);
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

async function crearProducto(cookie, nombre, stockActual, umbralMinimo) {
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
    .send({ nombre });

  expect(respuesta.status).toBe(201);
  return respuesta.body.id;
}

async function crearUbicacion(cookie, nombre) {
  const respuesta = await request(app)
    .post("/api/ubicaciones")
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

function consultar(cookie, query = {}) {
  return request(app).get("/api/kpis").query(query).set("Cookie", cookie);
}

let comercioA;
let comercioB;
let comercioVacio;
let comercioGrande;

const a = {};

/**
 * El fixture arma tres comercios y, en el grande, inserta miles de filas. No
 * entra en los 30 s de `testTimeout`, asi que el hook lleva el suyo, igual que
 * tests/comprasProveedor.test.js.
 */
const TIMEOUT_FIXTURE = 240000;

/**
 * El libro del comercio A, con los numeros esperados al lado.
 *
 *   producto   umbral  movimientos                                saldo final
 *   Yerba      10      alta +50 (Principal), compra X +20 (Dep.), 56
 *                      ventas -5 -3 -2 hoy, venta -4 hace 40 dias  (36 + 20)
 *   Fideos     20      alta +8, compra X +10, venta -1            17 bajo umbral
 *   Arroz      0       alta +1, compra sin proveedor +3, venta -4 0 sin stock
 *   Aceite     5       alta +30, compra Y +5; dado de alta hace   35 sin ventas
 *                      70 dias
 *   Lavandina  3       alta +5, despues dado de baja              no cuenta
 *
 * Con la ventana de 30 dias:
 *   stock: 4 productos, 108 unidades, 1 sin stock, 1 bajo umbral, 2 normales
 *   rotacion: 5 ventas, 15 unidades; Yerba 10, Arroz 4, Fideos 1
 *   compras: 4 compras, 38 unidades; X 2/30, Y 1/5, sin proveedor 1/3
 *
 * Con 60 dias entra la venta vieja de Yerba: 6 ventas, 19 unidades.
 */
beforeAll(async () => {
  limpiarCacheDeKpis();

  [comercioA, comercioB, comercioVacio, comercioGrande] = await Promise.all([
    registrarComercio("a"),
    registrarComercio("b"),
    registrarComercio("vacio"),
    registrarComercio("grande"),
  ]);

  // --- Comercio A ---------------------------------------------------------
  const { cookie } = comercioA;

  a.proveedorX = await crearProveedor(cookie, "Distribuidora X");
  a.proveedorY = await crearProveedor(cookie, "Distribuidora Y");
  a.yerba = await crearProducto(cookie, "Yerba 1kg", 50, 10);
  a.principalId = a.yerba.stock.ubicacionId;
  a.depositoId = await crearUbicacion(cookie, "Depósito");
  a.fideos = await crearProducto(cookie, "Fideos 500g", 8, 20);
  a.arroz = await crearProducto(cookie, "Arroz 1kg", 1, 0);
  a.aceite = await crearProducto(cookie, "Aceite 900ml", 30, 5);
  a.lavandina = await crearProducto(cookie, "Lavandina 1l", 5, 3);

  const enPrincipal = { ubicacionId: a.principalId };

  await registrarMovimiento(cookie, {
    productoId: a.yerba.id,
    tipo: "compra",
    cantidad: 20,
    proveedorId: a.proveedorX,
    ubicacionId: a.depositoId,
  });
  await registrarMovimiento(cookie, {
    productoId: a.fideos.id,
    tipo: "compra",
    cantidad: 10,
    proveedorId: a.proveedorX,
    ...enPrincipal,
  });
  await registrarMovimiento(cookie, {
    productoId: a.aceite.id,
    tipo: "compra",
    cantidad: 5,
    proveedorId: a.proveedorY,
    ...enPrincipal,
  });
  // `proveedorId` es opcional en las compras (HU-13).
  await registrarMovimiento(cookie, {
    productoId: a.arroz.id,
    tipo: "compra",
    cantidad: 3,
    ...enPrincipal,
  });

  for (const cantidad of [5, 3, 2]) {
    await registrarMovimiento(cookie, {
      productoId: a.yerba.id,
      tipo: "venta",
      cantidad,
      ...enPrincipal,
    });
  }
  const ventaVieja = await registrarMovimiento(cookie, {
    productoId: a.yerba.id,
    tipo: "venta",
    cantidad: 4,
    ...enPrincipal,
  });
  await registrarMovimiento(cookie, {
    productoId: a.fideos.id,
    tipo: "venta",
    cantidad: 1,
    ...enPrincipal,
  });
  await registrarMovimiento(cookie, {
    productoId: a.arroz.id,
    tipo: "venta",
    cantidad: 4,
    ...enPrincipal,
  });

  // La app nunca edita el libro: correr fechas es fixture, igual que en
  // tests/historial.test.js.
  await db
    .update(movimiento)
    .set({ fecha: haceDias(40) })
    .where(eq(movimiento.id, ventaVieja.id));
  await db
    .update(producto)
    .set({ createdAt: haceDias(70) })
    .where(eq(producto.id, a.aceite.id));

  const baja = await request(app)
    .delete(`/api/productos/${a.lavandina.id}`)
    .set("Cookie", cookie);
  if (baja.status !== 204) {
    throw new Error(`No se pudo dar de baja el producto: ${baja.status}`);
  }

  // --- Comercio B: actividad propia que A no tiene que ver ----------------
  const proveedorDeB = await crearProveedor(comercioB.cookie, "Proveedor de B");
  const deB = await crearProducto(comercioB.cookie, "Producto de B", 100, 1);
  await registrarMovimiento(comercioB.cookie, {
    productoId: deB.id,
    tipo: "compra",
    cantidad: 50,
    proveedorId: proveedorDeB,
    ubicacionId: deB.stock.ubicacionId,
  });
  await registrarMovimiento(comercioB.cookie, {
    productoId: deB.id,
    tipo: "venta",
    cantidad: 70,
    ubicacionId: deB.stock.ubicacionId,
  });

  await armarComercioGrande();
}, TIMEOUT_FIXTURE);

/* ---------------------------------------------------------------------------
 * Volumen para la prueba de rendimiento
 * ------------------------------------------------------------------------- */

const PRODUCTOS_GRANDE = 300;
const PROVEEDORES_GRANDE = 15;
/** Pares compra/venta: el libro termina con el doble de filas. */
const PARES_GRANDE = 15000;
const DIAS_DE_HISTORIA = 180;

/**
 * Un comercio con un año largo de un almacen de barrio: 300 productos, 15
 * proveedores y 30.000 movimientos repartidos en seis meses.
 *
 * Se inserta directo en la base: por la API serian treinta mil requests. Para
 * no romper el invariante de `stock` (STOCK = SUM(MOVIMIENTO)), cada producto
 * entra con su ajuste inicial y cada venta va pareada con una compra de la
 * misma cantidad, asi que el saldo de cada producto es su ajuste.
 */
async function armarComercioGrande() {
  const base = await crearProducto(comercioGrande.cookie, "Producto 0", 10, 5);
  const ubicacionId = base.stock.ubicacionId;

  const [{ comercioId }] = await db
    .select({ comercioId: producto.comercioId })
    .from(producto)
    .where(eq(producto.id, base.id));
  comercioGrande.comercioId = comercioId;

  const [{ usuarioId }] = await db
    .select({ usuarioId: user.id })
    .from(user)
    .where(eq(user.email, comercioGrande.email));

  const nuevos = await db
    .insert(producto)
    .values(
      Array.from({ length: PRODUCTOS_GRANDE - 1 }, (_, i) => ({
        comercioId,
        nombre: `Producto ${i + 1}`,
        codigoBarras: `G${SUFIJO}-${i + 1}`.slice(0, 64),
        categoria: "Almacén",
        unidadMedida: "unidad",
        umbralMinimo: i % 7,
        createdAt: haceDias(DIAS_DE_HISTORIA + 10),
      })),
    )
    .returning({ id: producto.id });

  const productoIds = [base.id, ...nuevos.map((fila) => fila.id)];
  const saldoInicial = (i) => (i % 10) * 3;

  await db.insert(stock).values(
    nuevos.map((fila, i) => ({
      comercioId,
      productoId: fila.id,
      ubicacionId,
      cantidad: saldoInicial(i + 1),
    })),
  );

  const proveedores = await db
    .insert(proveedor)
    .values(
      Array.from({ length: PROVEEDORES_GRANDE }, (_, i) => ({
        comercioId,
        nombre: `Proveedor ${i + 1}`,
      })),
    )
    .returning({ id: proveedor.id });

  const filas = nuevos.map((fila, i) => ({
    comercioId,
    productoId: fila.id,
    ubicacionId,
    usuarioId,
    tipo: "ajuste",
    cantidad: saldoInicial(i + 1),
    motivo: "Stock inicial",
    fecha: haceDias(DIAS_DE_HISTORIA + 5),
  }));

  for (let i = 0; i < PARES_GRANDE; i += 1) {
    const productoId = productoIds[i % productoIds.length];
    const cantidad = (i % 5) + 1;
    // Repartidas en toda la historia, la compra un rato antes que la venta.
    const fecha = new Date(
      Date.now() - ((i * 7919) % (DIAS_DE_HISTORIA * 24)) * 60 * 60 * 1000,
    );

    filas.push(
      {
        comercioId,
        productoId,
        ubicacionId,
        usuarioId,
        tipo: "compra",
        cantidad,
        proveedorId: proveedores[i % proveedores.length].id,
        fecha: new Date(fecha.getTime() - 60 * 60 * 1000),
      },
      {
        comercioId,
        productoId,
        ubicacionId,
        usuarioId,
        tipo: "venta",
        cantidad: -cantidad,
        fecha,
      },
    );
  }

  // De a 2.000 filas: 10 columnas por fila quedan lejos del tope de 65.535
  // parametros por consulta de Postgres.
  for (let i = 0; i < filas.length; i += 2000) {
    await db.insert(movimiento).values(filas.slice(i, i + 2000));
  }

  // Las estadisticas del planificador, como estarian en una base en uso: sin
  // esto, Postgres puede elegir el plan pensando que la tabla esta vacia.
  await db.execute(sql`analyze movimiento`);
}

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // El comercio antes que el usuario: `movimiento.usuario_id` es `restrict`.
  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
}, TIMEOUT_FIXTURE);

/* ---------------------------------------------------------------------------
 * Tests
 * ------------------------------------------------------------------------- */

describe("GET /api/kpis — acceso", () => {
  test("sin sesion responde 401", async () => {
    const respuesta = await request(app).get("/api/kpis");
    expect(respuesta.status).toBe(401);
  });

  test("un `dias` invalido es 400 con el mensaje de la API", async () => {
    const respuesta = await consultar(comercioA.cookie, { dias: "0" });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/"dias"/);
  });
});

describe("GET /api/kpis — exactitud contra un libro conocido", () => {
  let kpis;

  beforeAll(async () => {
    const respuesta = await consultar(comercioA.cookie);
    if (respuesta.status !== 200) {
      throw new Error(`No se pudieron leer los KPIs: ${respuesta.status}`);
    }
    kpis = respuesta.body;
  });

  test("informa la ventana pedida, en dias calendario de Argentina", () => {
    const esperada = ventanaDeDias(DIAS_POR_DEFECTO);

    expect(kpis.periodo.dias).toBe(DIAS_POR_DEFECTO);
    expect(kpis.periodo.desde).toBe(esperada.desde.toISOString());
    expect(kpis.periodo.zonaHoraria).toBe("America/Argentina/Buenos_Aires");
  });

  test("estado del stock: categorias excluyentes que suman el total", () => {
    expect(kpis.stock).toMatchObject({
      productos: 4,
      unidades: 108,
      sinStock: 1,
      bajoUmbral: 1,
      normal: 2,
      productosSinVentas: 1,
    });
  });

  test("el stock por ubicacion no cuenta el producto dado de baja", () => {
    expect(kpis.stock.porUbicacion).toEqual([
      { id: a.depositoId, nombre: "Depósito", unidades: 20, productos: 1 },
      // 36 de yerba + 17 de fideos + 35 de aceite. La lavandina dada de baja
      // tiene 5 unidades ahi y no suman; el arroz esta en 0.
      { id: a.principalId, nombre: expect.any(String), unidades: 88, productos: 3 },
    ]);
  });

  test("rotacion: solo las ventas de la ventana", () => {
    expect(kpis.rotacion.ventas).toBe(5);
    expect(kpis.rotacion.unidadesVendidas).toBe(15);
    expect(kpis.rotacion.productosSinVentas).toBe(1);
    expect(kpis.rotacion.montos).toBeNull();
  });

  test("los mas vendidos van por unidades, con su cobertura", () => {
    expect(
      kpis.rotacion.masVendidos.map((fila) => ({
        id: fila.producto.id,
        ventas: fila.ventas,
        unidadesVendidas: fila.unidadesVendidas,
        stockActual: fila.stockActual,
        diasDeCobertura: fila.diasDeCobertura,
      })),
    ).toEqual([
      // 56 / (10 / 30) = 168 dias.
      { id: a.yerba.id, ventas: 3, unidadesVendidas: 10, stockActual: 56, diasDeCobertura: 168 },
      { id: a.arroz.id, ventas: 1, unidadesVendidas: 4, stockActual: 0, diasDeCobertura: 0 },
      // 17 / (1 / 30) = 510 dias.
      { id: a.fideos.id, ventas: 1, unidadesVendidas: 1, stockActual: 17, diasDeCobertura: 510 },
    ]);
    expect(kpis.rotacion.masVendidos.length).toBeLessThanOrEqual(
      LIMITE_MAS_VENDIDOS,
    );
  });

  test("la serie diaria tiene un dia por dia de la ventana y suma el total", () => {
    const serie = kpis.rotacion.porDia;
    const esperada = ventanaDeDias(DIAS_POR_DEFECTO);

    expect(serie.map((dia) => dia.fecha)).toEqual(esperada.fechas);
    expect(serie.reduce((suma, dia) => suma + dia.unidades, 0)).toBe(15);
    expect(serie.at(-1)).toEqual({
      fecha: esperada.hoy,
      ventas: 5,
      unidades: 15,
    });
  });

  test("compras por proveedor: solo compras, con las sin proveedor aparte", () => {
    const compras = kpis.comprasPorProveedor;

    expect(compras).toMatchObject({
      compras: 4,
      unidades: 38,
      proveedoresConCompras: 2,
      otros: null,
      sinProveedor: { compras: 1, unidades: 3 },
      montos: null,
    });
    expect(
      compras.proveedores.map(({ proveedor: p, compras: c, unidades }) => ({
        id: p.id,
        nombre: p.nombre,
        compras: c,
        unidades,
      })),
    ).toEqual([
      { id: a.proveedorX, nombre: "Distribuidora X", compras: 2, unidades: 30 },
      { id: a.proveedorY, nombre: "Distribuidora Y", compras: 1, unidades: 5 },
    ]);
    expect(compras.proveedores[0].ultimaCompra).toEqual(expect.any(String));
  });

  test("una ventana mas larga suma la venta vieja", async () => {
    const respuesta = await consultar(comercioA.cookie, { dias: "60" });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.periodo.dias).toBe(60);
    expect(respuesta.body.rotacion.ventas).toBe(6);
    expect(respuesta.body.rotacion.unidadesVendidas).toBe(19);
    expect(respuesta.body.rotacion.porDia).toHaveLength(60);
    // El stock es el estado actual: no depende de la ventana.
    expect(respuesta.body.stock.unidades).toBe(108);
  });
});

describe("GET /api/kpis — aislamiento por comercio", () => {
  test("cada comercio ve solo lo suyo", async () => {
    const respuesta = await consultar(comercioB.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.stock).toMatchObject({ productos: 1, unidades: 80 });
    expect(respuesta.body.rotacion.unidadesVendidas).toBe(70);
    expect(respuesta.body.comprasPorProveedor.unidades).toBe(50);
    expect(
      respuesta.body.comprasPorProveedor.proveedores.map(
        (fila) => fila.proveedor.nombre,
      ),
    ).toEqual(["Proveedor de B"]);

    const idsDeA = new Set([a.yerba.id, a.fideos.id, a.arroz.id, a.aceite.id]);
    for (const fila of respuesta.body.rotacion.masVendidos) {
      expect(idsDeA.has(fila.producto.id)).toBe(false);
    }
  });

  test("un comercioId en la query string no cambia de comercio", async () => {
    const respuesta = await consultar(comercioB.cookie, {
      comercioId: comercioGrande.comercioId,
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.stock.productos).toBe(1);
  });

  test("un comercio sin actividad recibe ceros, no errores", async () => {
    const respuesta = await consultar(comercioVacio.cookie, { dias: "7" });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.stock).toMatchObject({
      productos: 0,
      unidades: 0,
      sinStock: 0,
      bajoUmbral: 0,
      normal: 0,
      productosSinVentas: 0,
    });
    expect(respuesta.body.rotacion).toMatchObject({
      ventas: 0,
      unidadesVendidas: 0,
      masVendidos: [],
    });
    expect(respuesta.body.rotacion.porDia).toHaveLength(7);
    expect(respuesta.body.comprasPorProveedor).toMatchObject({
      compras: 0,
      proveedores: [],
      otros: null,
      sinProveedor: null,
    });
  });
});

describe("GET /api/kpis — rendimiento (RNF2)", () => {
  test(`con ${PARES_GRANDE * 2} movimientos carga en menos de ${TOPE_DE_CARGA_MS} ms`, async () => {
    // En frio: sin nada en la cache, es el peor caso real.
    limpiarCacheDeKpis();

    const inicio = performance.now();
    const respuesta = await consultar(comercioGrande.cookie);
    const duracion = performance.now() - inicio;

    expect(respuesta.status).toBe(200);
    expect(duracion).toBeLessThan(TOPE_DE_CARGA_MS);

    // Y con numeros correctos, no solo rapidos.
    const { desde } = ventanaDeDias(DIAS_POR_DEFECTO);
    const [esperado] = await db
      .select({
        ventas: sql`count(*)`.mapWith(Number),
        unidades: sql`-sum(${movimiento.cantidad})`.mapWith(Number),
      })
      .from(movimiento)
      .where(
        and(
          eq(movimiento.comercioId, comercioGrande.comercioId),
          eq(movimiento.tipo, "venta"),
          gte(movimiento.fecha, desde),
        ),
      );

    expect(respuesta.body.stock.productos).toBe(PRODUCTOS_GRANDE);
    expect(respuesta.body.rotacion.ventas).toBe(esperado.ventas);
    expect(respuesta.body.rotacion.unidadesVendidas).toBe(esperado.unidades);
    expect(respuesta.body.comprasPorProveedor.proveedoresConCompras).toBe(
      PROVEEDORES_GRANDE,
    );
    expect(respuesta.body.comprasPorProveedor.otros).not.toBeNull();
  });
});

describe("GET /api/kpis — cache", () => {
  test("sin cambios, la segunda carga sale de la cache", async () => {
    const primera = await consultar(comercioA.cookie);
    const segunda = await consultar(comercioA.cookie);

    expect(segunda.status).toBe(200);
    expect(segunda.body.generadoEn).toBe(primera.body.generadoEn);
  });

  test("una venta nueva se ve en la carga siguiente (tiempo real)", async () => {
    const antes = await consultar(comercioA.cookie);

    await registrarMovimiento(comercioA.cookie, {
      productoId: a.fideos.id,
      tipo: "venta",
      cantidad: 2,
      ubicacionId: a.principalId,
    });

    const despues = await consultar(comercioA.cookie);

    expect(despues.body.generadoEn).not.toBe(antes.body.generadoEn);
    expect(despues.body.rotacion.unidadesVendidas).toBe(
      antes.body.rotacion.unidadesVendidas + 2,
    );
    expect(despues.body.stock.unidades).toBe(antes.body.stock.unidades - 2);
  });

  test("cambiar un umbral tambien invalida la cache", async () => {
    const antes = await consultar(comercioA.cookie);
    expect(antes.body.stock.bajoUmbral).toBe(1);

    // Aceite tiene 35: con umbral 40 pasa a estar bajo el umbral.
    const cambio = await request(app)
      .put(`/api/productos/${a.aceite.id}/umbral`)
      .set("Cookie", comercioA.cookie)
      .send({ umbralMinimo: 40 });
    expect(cambio.status).toBe(200);

    const despues = await consultar(comercioA.cookie);
    expect(despues.body.stock.bajoUmbral).toBe(2);
  });
});
