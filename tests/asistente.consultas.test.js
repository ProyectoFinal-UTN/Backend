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
  producto,
  user,
} from "../src/db/schema.js";
import { rotacionDeProductos } from "../src/services/asistente.consultas.service.js";

/**
 * Test de integracion de `rotacionDeProductos`, el insumo del analisis de baja
 * rotacion (HU-27).
 *
 * Corre contra la base real y no mockeado, porque lo que se prueba vive en el
 * SQL y no en JS: el filtro del producto recien dado de alta, el del stock en
 * cero, el signo con que se guardan las ventas y el filtro por comercio. Un
 * mock de la consulta devolveria lo que el test quiera y no probaria ninguna de
 * las cuatro.
 *
 * El complemento esta en `tests/asistente.recomendaciones.test.js`, que con
 * esta consulta mockeada prueba el criterio y la redaccion. Ninguno de los dos
 * llama al LLM.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu27-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

const DIAS = 30;

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `78901${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
}

function hace(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
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

  const [fila] = await db
    .select({ id: comercio.id })
    .from(comercio)
    .innerJoin(member, eq(member.organizationId, comercio.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(user.email, email));

  return { email, cookie, comercioId: fila.id };
}

/**
 * Crea un producto y, si se pide, lo envejece.
 *
 * `created_at` se escribe directo porque la API no deja elegirlo —y no tiene
 * por que dejarlo—, pero el filtro "ya existia cuando empezo la ventana" no se
 * puede probar con productos que nacieron hace un segundo.
 */
async function crearProducto(cookie, { stockActual, antiguedadEnDias } = {}) {
  const respuesta = await request(app)
    .post("/api/productos")
    .set("Cookie", cookie)
    .send({
      nombre: `Producto ${contadorCodigo + 1}`,
      codigoBarras: codigoBarras(),
      categoria: "Almacén",
      unidadMedida: "unidad",
      umbralMinimo: 2,
      stockActual,
    });

  expect(respuesta.status).toBe(201);

  if (antiguedadEnDias) {
    await db
      .update(producto)
      .set({ createdAt: hace(antiguedadEnDias) })
      .where(eq(producto.id, respuesta.body.id));
  }

  return respuesta.body;
}

/** Registra una venta y, si se pide, la manda hacia atras en el tiempo. */
async function venderUnidades(cookie, productoId, cantidad, antiguedadEnDias) {
  const respuesta = await request(app)
    .post("/api/movimientos")
    .set("Cookie", cookie)
    .send({ productoId, tipo: "venta", cantidad });

  expect(respuesta.status).toBe(201);

  if (antiguedadEnDias) {
    await db
      .update(movimiento)
      .set({ fecha: hace(antiguedadEnDias) })
      .where(eq(movimiento.id, respuesta.body.movimiento.id));
  }

  return respuesta.body.movimiento;
}

let principal;
let vecino;
let viejoQuieto;
let viejoVendido;
let recienCreado;
let sinExistencias;
let ventaFueraDeVentana;

beforeAll(async () => {
  principal = await registrarComercio("principal");
  vecino = await registrarComercio("vecino");

  // Con stock, viejo y sin venderse: el caso que la HU quiere detectar.
  viejoQuieto = await crearProducto(principal.cookie, {
    stockActual: 12,
    antiguedadEnDias: 60,
  });

  // Viejo y con una venta adentro de la ventana: no es de baja rotacion.
  viejoVendido = await crearProducto(principal.cookie, {
    stockActual: 20,
    antiguedadEnDias: 60,
  });
  await venderUnidades(principal.cookie, viejoVendido.id, 5);

  // Recien dado de alta: no tiene poca rotacion, tiene poca historia.
  recienCreado = await crearProducto(principal.cookie, { stockActual: 8 });

  // Viejo pero sin existencias: no hay nada inmovilizado que recomendar.
  sinExistencias = await crearProducto(principal.cookie, {
    stockActual: 0,
    antiguedadEnDias: 60,
  });

  // Viejo, con stock, y con una venta anterior a la ventana.
  ventaFueraDeVentana = await crearProducto(principal.cookie, {
    stockActual: 10,
    antiguedadEnDias: 60,
  });
  await venderUnidades(principal.cookie, ventaFueraDeVentana.id, 3, 60);

  // El vecino tiene lo mismo: si el filtro por comercio no estuviera, saldria
  // en el analisis del comercio principal.
  const delVecino = await crearProducto(vecino.cookie, {
    stockActual: 50,
    antiguedadEnDias: 60,
  });
  vecino.productoId = delVecino.id;
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // El comercio primero: `movimiento.usuario_id` es `onDelete: restrict`, asi
  // que borrar el usuario antes falla mientras existan sus movimientos.
  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

/** Los ids que devolvio la consulta, para afirmar sobre pertenencia. */
async function analizar(comercioId = principal.comercioId) {
  const resultado = await rotacionDeProductos(comercioId, { dias: DIAS });

  return {
    ...resultado,
    ids: resultado.productos.map((fila) => fila.id),
    porId: new Map(resultado.productos.map((fila) => [fila.id, fila])),
  };
}

describe("rotacionDeProductos — quién entra en el análisis", () => {
  test("un producto viejo con existencias entra, con cero ventas", async () => {
    const { porId } = await analizar();

    expect(porId.get(viejoQuieto.id)).toMatchObject({
      enStock: 12,
      ventas: 0,
      unidadesVendidas: 0,
    });
  });

  test("un producto dado de alta dentro de la ventana no entra", async () => {
    // Es el falso positivo más grande de la HU: sin este filtro, cargar el
    // catálogo genera una recomendación de baja rotación por cada producto.
    const { ids } = await analizar();

    expect(ids).not.toContain(recienCreado.id);
  });

  test("un producto sin existencias no entra", async () => {
    const { ids } = await analizar();

    expect(ids).not.toContain(sinExistencias.id);
  });

  test("solo entran los productos del comercio que pregunta", async () => {
    const { ids } = await analizar();

    expect(ids).not.toContain(vecino.productoId);

    // Y al revés: el vecino ve lo suyo y nada del principal.
    const delVecino = await analizar(vecino.comercioId);

    expect(delVecino.ids).toEqual([vecino.productoId]);
  });
});

describe("rotacionDeProductos — el signo de las ventas", () => {
  test("una venta se guarda en negativo y se informa en unidades positivas", async () => {
    // `SIGNO_POR_TIPO` en movimientos.service.js guarda las ventas con
    // `cantidad` negativa. Si la consulta sumara sin dar vuelta el signo,
    // acá vendría -5 y cualquier umbral comparado contra eso quedaría al revés.
    const { porId } = await analizar();

    expect(porId.get(viejoVendido.id)).toMatchObject({
      ventas: 1,
      unidadesVendidas: 5,
    });
  });

  test("un producto que vendió no queda con cero ventas", async () => {
    const { porId } = await analizar();

    expect(porId.get(viejoVendido.id).ventas).toBeGreaterThan(0);
  });
});

describe("rotacionDeProductos — la ventana", () => {
  test("una venta anterior a la ventana no cuenta como rotación", async () => {
    const { porId } = await analizar();

    // El producto entra al análisis —es viejo y tiene stock— pero con cero
    // ventas, porque la única que tuvo quedó fuera de los 30 días.
    expect(porId.get(ventaFueraDeVentana.id)).toMatchObject({
      ventas: 0,
      unidadesVendidas: 0,
    });
  });

  test("informa la ventana que efectivamente usó", async () => {
    const resultado = await rotacionDeProductos(principal.comercioId, {
      dias: DIAS,
    });

    expect(resultado.dias).toBe(DIAS);
    expect(resultado.desde.getTime()).toBeLessThan(Date.now());
  });

  test("una ventana inválida cae en el default de 30 días", async () => {
    const resultado = await rotacionDeProductos(principal.comercioId, {
      dias: "muchos",
    });

    expect(resultado.dias).toBe(30);
  });
});

describe("rotacionDeProductos — ventas del comercio", () => {
  test("cuenta las ventas de la ventana, no las de los productos analizados", async () => {
    // Es el número con el que se decide si hay histórico suficiente, así que
    // tiene que contar todo lo que se vendió. Acá hay una sola venta dentro de
    // la ventana: la de `viejoVendido`. La de `ventaFueraDeVentana` quedó
    // afuera por fecha.
    const resultado = await analizar();

    expect(resultado.ventasDelComercio).toBe(1);
  });

  test("un comercio sin ventas registradas informa cero", async () => {
    const resultado = await analizar(vecino.comercioId);

    expect(resultado.ventasDelComercio).toBe(0);
    // Y aun así devuelve sus productos: el que decide qué hacer con un cero es
    // el service de recomendaciones, no esta consulta.
    expect(resultado.productos).toHaveLength(1);
  });
});
