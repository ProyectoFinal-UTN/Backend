import { describe, expect, test } from "@jest/globals";
import { validarDatosProducto } from "../src/services/productos.service.js";

/**
 * Unitario puro de la validacion de HU-9 — no toca la base, igual que
 * `tests/comercios.service.test.js` con `generarSlug`. El resto de la logica
 * de productos (que si toca la base) se cubre en `tests/productos.test.js`.
 */

const DATOS_VALIDOS = {
  nombre: "Coca-Cola 500ml",
  codigoBarras: "7790895000782",
  categoria: "Bebidas",
  unidadMedida: "unidad",
  umbralMinimo: 5,
  stockActual: 20,
};

function sinCampo(objeto, campo) {
  const copia = { ...objeto };
  delete copia[campo];
  return copia;
}

describe("validarDatosProducto — alta (no parcial)", () => {
  test("acepta datos completos y normaliza espacios/mayúsculas", () => {
    const resultado = validarDatosProducto({
      ...DATOS_VALIDOS,
      nombre: "  Coca-Cola 500ml  ",
      unidadMedida: "UNIDAD",
    });

    expect(resultado).toEqual(DATOS_VALIDOS);
  });

  test("rechaza cuando falta el nombre", () => {
    expect(() =>
      validarDatosProducto(sinCampo(DATOS_VALIDOS, "nombre")),
    ).toThrow(/nombre/i);
  });

  test("rechaza un nombre vacío o solo espacios", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, nombre: "   " }),
    ).toThrow(/nombre/i);
  });

  test("rechaza un código de barras con letras", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, codigoBarras: "abc123" }),
    ).toThrow(/código de barras/i);
  });

  test("rechaza un código de barras vacío", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, codigoBarras: "" }),
    ).toThrow(/código de barras/i);
  });

  test("rechaza cuando falta la categoría", () => {
    expect(() =>
      validarDatosProducto(sinCampo(DATOS_VALIDOS, "categoria")),
    ).toThrow(/categoría/i);
  });

  test("rechaza una unidad de medida fuera del allow-list", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, unidadMedida: "toneladas" }),
    ).toThrow(/unidad de medida/i);
  });

  test("rechaza un umbral mínimo negativo", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, umbralMinimo: -1 }),
    ).toThrow(/umbral mínimo/i);
  });

  test("rechaza un umbral mínimo no entero", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, umbralMinimo: 1.5 }),
    ).toThrow(/umbral mínimo/i);
  });

  test("rechaza un umbral mínimo que desbordaría la columna integer", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, umbralMinimo: 3000000000 }),
    ).toThrow(/umbral mínimo/i);
  });

  test("rechaza un umbral mínimo null (no lo trata como 0)", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, umbralMinimo: null }),
    ).toThrow(/umbral mínimo/i);
  });

  test("rechaza un stock actual negativo", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, stockActual: -5 }),
    ).toThrow(/stock actual/i);
  });

  test("rechaza cuando falta el stock actual", () => {
    expect(() =>
      validarDatosProducto(sinCampo(DATOS_VALIDOS, "stockActual")),
    ).toThrow(/stock actual/i);
  });

  test("rechaza un stock actual que desbordaría la columna integer", () => {
    // Sin el tope, el INSERT falla con 22003 y sale como 500, no como 400.
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, stockActual: 3000000000 }),
    ).toThrow(/stock actual/i);
  });

  test("acepta el máximo que entra en un integer de Postgres", () => {
    expect(
      validarDatosProducto({ ...DATOS_VALIDOS, stockActual: 2147483647 }),
    ).toMatchObject({ stockActual: 2147483647 });
  });

  test("rechaza un stock actual null (no lo trata como 0)", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, stockActual: null }),
    ).toThrow(/stock actual/i);
  });

  test("rechaza un stock actual como string (exige number, no coerciona)", () => {
    expect(() =>
      validarDatosProducto({ ...DATOS_VALIDOS, stockActual: "20" }),
    ).toThrow(/stock actual/i);
  });

  test("ignora cualquier comercioId que venga mezclado en los datos", () => {
    const resultado = validarDatosProducto({
      ...DATOS_VALIDOS,
      comercioId: "otro-comercio",
    });

    expect(resultado).not.toHaveProperty("comercioId");
  });
});

describe("validarDatosProducto — edición (parcial)", () => {
  test("acepta un patch con un solo campo", () => {
    expect(
      validarDatosProducto({ categoria: "Almacén" }, { parcial: true }),
    ).toEqual({ categoria: "Almacén" });
  });

  test("no exige stockActual en un patch", () => {
    expect(
      validarDatosProducto({ nombre: "Nuevo nombre" }, { parcial: true }),
    ).toEqual({ nombre: "Nuevo nombre" });
  });

  test("ignora stockActual aunque venga en el patch", () => {
    const resultado = validarDatosProducto(
      { categoria: "Almacén", stockActual: 999 },
      { parcial: true },
    );

    expect(resultado).not.toHaveProperty("stockActual");
  });

  test("valida igual los campos que sí vienen en el patch", () => {
    expect(() =>
      validarDatosProducto({ umbralMinimo: -3 }, { parcial: true }),
    ).toThrow(/umbral mínimo/i);
  });

  test("un patch vacío no rechaza nada", () => {
    expect(validarDatosProducto({}, { parcial: true })).toEqual({});
  });
});