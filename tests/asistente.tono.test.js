import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * El tono del asistente: cordial pero no coloquial, y nunca en imperativo.
 *
 * Lo que redacta el modelo no se puede afirmar palabra por palabra (y ningun
 * test llama al modelo real: el credito es compartido). Lo que si se puede
 * afirmar es que las dos voces —el chat de HU-26 y el resumen de HU-27— le
 * pasan al modelo las mismas reglas de tono, y que las frases fijas, que no
 * pasan por el modelo, las cumplen.
 */

const consultarModelo = jest.fn();

jest.unstable_mockModule("../src/lib/llm.js", () => ({
  consultarModelo,
  hayProveedorConfigurado: jest.fn(() => true),
  TIMEOUT_MS: 4000,
}));

jest.unstable_mockModule("../src/services/asistente.consultas.service.js", () => ({
  TIPOS_DE_MOVIMIENTO: ["compra", "venta", "merma", "ajuste", "transferencia"],
  // Sin productos para reponer y sin ventas: alcanza para que el resumen tenga
  // algo que presentar (`sin_historial`) sin que nada salga a la base.
  productosParaReponer: jest.fn(async () => []),
  rotacionDeProductos: jest.fn(async () => ({
    dias: 30,
    desde: new Date("2026-09-25T12:00:00.000Z"),
    ventasDelComercio: 0,
    productos: [],
  })),
  stockDeProducto: jest.fn(async () => []),
  movimientosRecientes: jest.fn(async () => ({ movimientos: [] })),
  resumenDeActividad: jest.fn(async () => ({ porTipo: [] })),
}));

const { REGLAS_DE_TONO } = await import("../src/services/asistente.tono.js");
const { responder } = await import("../src/services/asistente.service.js");
const { analizar, recomendar, limpiarCacheDeResumen } = await import(
  "../src/services/asistente.recomendaciones.service.js"
);
const { responderPorReglas } = await import(
  "../src/services/asistente.reglas.service.js"
);

const COMERCIO_ID = "123e4567-e89b-12d3-a456-426614174000";

const USO = { modelo: "google/gemini-2.5-flash", entrada: 100, salida: 20, costoUsd: 0.0001 };

/**
 * Imperativos de vos y muletillas que el asistente no tiene que usar.
 *
 * Los bordes son `\p{L}` y no `\b`: para `\b` la "á" no es una letra, así que
 * `/\bregistrá\b/` no matchea "Registrá tus ventas" y los imperativos con
 * tilde —que son casi todos— pasarían sin que nadie se entere.
 */
const SUENA_A_ORDEN_O_A_MULETILLA =
  /(?<!\p{L})(che|mirá|fijate|dale|registrá|cargá|revisá|pedí|decime|hacé|probá)(?!\p{L})/iu;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  limpiarCacheDeResumen();
  consultarModelo.mockResolvedValue({ texto: "Texto del modelo.", herramientasUsadas: [], uso: USO });
});

describe("Las reglas de tono", () => {
  test("piden cercanía sin coloquialismos y prohíben el imperativo", () => {
    expect(REGLAS_DE_TONO).toMatch(/cordial y profesional/);
    expect(REGLAS_DE_TONO).toMatch(/"che"/);
    expect(REGLAS_DE_TONO).toMatch(/"mirá"/);
    expect(REGLAS_DE_TONO).toMatch(/imperativo/);
  });

  test("el chat (HU-26) se las pasa al modelo", async () => {
    await responder(COMERCIO_ID, { pregunta: "¿Qué tengo que reponer?" });

    expect(consultarModelo.mock.calls[0][0].instrucciones).toContain(REGLAS_DE_TONO);
  });

  test("el resumen de las sugerencias (HU-27) también, así las dos voces son la misma", async () => {
    await recomendar(COMERCIO_ID);

    expect(consultarModelo).toHaveBeenCalledTimes(1);
    expect(consultarModelo.mock.calls[0][0].instrucciones).toContain(REGLAS_DE_TONO);
  });
});

describe("Las frases fijas, que no pasan por el modelo", () => {
  test("la sugerencia sin historial no le ordena cargar las ventas", async () => {
    const { recomendaciones } = await analizar(COMERCIO_ID);
    const [sinHistorial] = recomendaciones;

    expect(sinHistorial.tipo).toBe("sin_historial");
    expect(sinHistorial.texto).not.toMatch(SUENA_A_ORDEN_O_A_MULETILLA);
  });

  test("el modo limitado no pide el nombre del producto en imperativo", async () => {
    const respuesta = await responderPorReglas(COMERCIO_ID, "¿cuánto me queda?");

    expect(respuesta).toMatch(/de qué producto/i);
    expect(respuesta).not.toMatch(SUENA_A_ORDEN_O_A_MULETILLA);
  });
});
