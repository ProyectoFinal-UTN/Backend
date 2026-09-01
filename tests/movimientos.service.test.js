import { describe, expect, test } from "@jest/globals";
import { validarDatosMovimiento } from "../src/services/movimientos.service.js";

/**
 * Unitario puro de la validacion de HU-13 — no toca la base, igual que
 * `tests/productos.service.test.js` con `validarDatosProducto`. El resto de la
 * logica (la transaccion, el stock insuficiente, la resolucion de ubicacion)
 * se cubre en `tests/movimientos.test.js`, que si necesita datos reales.
 */

const PRODUCTO_ID = "123e4567-e89b-12d3-a456-426614174000";
const UBICACION_ID = "223e4567-e89b-12d3-a456-426614174001";
const PROVEEDOR_ID = "323e4567-e89b-12d3-a456-426614174002";

function movimiento(overrides = {}) {
  return { productoId: PRODUCTO_ID, tipo: "venta", cantidad: 3, ...overrides };
}

describe("validarDatosMovimiento — signo según el tipo", () => {
  test("una compra suma: la cantidad queda positiva", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "compra" })).cantidad).toBe(
      3,
    );
  });

  test("una venta resta: la cantidad queda negativa", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "venta" })).cantidad).toBe(
      -3,
    );
  });

  test("una merma resta", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "merma" })).cantidad).toBe(
      -3,
    );
  });

  test("normaliza el tipo con espacios y mayúsculas", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "  COMPRA " })).tipo).toBe(
      "compra",
    );
  });
});

describe("validarDatosMovimiento — ajuste", () => {
  test("con sentido entrada suma", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "ajuste", sentido: "entrada" }))
        .cantidad,
    ).toBe(3);
  });

  test("con sentido salida resta", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "ajuste", sentido: "salida" }))
        .cantidad,
    ).toBe(-3);
  });

  test("sin sentido lo rechaza: el signo sería ambiguo", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "ajuste" })),
    ).toThrow(/sentido/i);
  });

  test("con un sentido inválido lo rechaza", () => {
    expect(() =>
      validarDatosMovimiento(
        movimiento({ tipo: "ajuste", sentido: "cualquiera" }),
      ),
    ).toThrow(/sentido/i);
  });

  test("el sentido se ignora en los tipos que no son ajuste", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "venta", sentido: "entrada" }))
        .cantidad,
    ).toBe(-3);
  });
});

describe("validarDatosMovimiento — tipo", () => {
  test("rechaza un tipo que no existe", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "devolucion" })),
    ).toThrow(/tipo de movimiento/i);
  });

  test("rechaza 'transferencia': esos movimientos los crea HU-12 en pares ligados", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "transferencia" })),
    ).toThrow(/tipo de movimiento/i);
  });

  test("rechaza cuando falta el tipo", () => {
    expect(() => validarDatosMovimiento({ productoId: PRODUCTO_ID, cantidad: 3 })).toThrow(
      /tipo de movimiento/i,
    );
  });
});

describe("validarDatosMovimiento — cantidad", () => {
  test.each([
    ["cero", 0],
    ["negativa", -5],
    ["decimal", 1.5],
    ["texto", "muchas"],
    ["ausente", undefined],
    ["nula", null],
    // Los tres siguientes son los que `Number(...)` colaria: `Number(true)` da
    // 1, `Number([3])` da 3 y `Number("4")` da 4. Un campo mal serializado no
    // puede entrar como movimiento real en un libro que no se puede editar.
    ["booleana", true],
    ["un array", [3]],
    ["numérica pero en string", "4"],
  ])("rechaza una cantidad %s", (_caso, cantidad) => {
    expect(() => validarDatosMovimiento(movimiento({ cantidad }))).toThrow(
      /cantidad/i,
    );
  });

  test("acepta el máximo que entra en un integer de Postgres", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "compra", cantidad: 2147483647 }))
        .cantidad,
    ).toBe(2147483647);
  });

  test("rechaza una cantidad que desbordaría la columna integer", () => {
    // Sin este tope el INSERT falla con 22003 y sale como 500, no como 400.
    expect(() =>
      validarDatosMovimiento(movimiento({ cantidad: 3000000000 })),
    ).toThrow(/cantidad/i);
  });
});

describe("validarDatosMovimiento — producto, ubicación y proveedor", () => {
  test("rechaza un productoId que no es UUID", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ productoId: "no-es-uuid" })),
    ).toThrow(/producto/i);
  });

  test("rechaza cuando falta el productoId", () => {
    expect(() => validarDatosMovimiento({ tipo: "venta", cantidad: 3 })).toThrow(
      /producto/i,
    );
  });

  test("la ubicación es opcional y queda undefined si no viene", () => {
    expect(validarDatosMovimiento(movimiento()).ubicacionId).toBeUndefined();
  });

  test("acepta una ubicación con formato válido", () => {
    expect(
      validarDatosMovimiento(movimiento({ ubicacionId: UBICACION_ID }))
        .ubicacionId,
    ).toBe(UBICACION_ID);
  });

  test("rechaza una ubicación que no es UUID", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ ubicacionId: "no-es-uuid" })),
    ).toThrow(/ubicación/i);
  });

  test("el proveedor es opcional y queda en null si no viene", () => {
    expect(validarDatosMovimiento(movimiento()).proveedorId).toBeNull();
  });

  test("acepta un proveedor con formato válido", () => {
    expect(
      validarDatosMovimiento(movimiento({ proveedorId: PROVEEDOR_ID }))
        .proveedorId,
    ).toBe(PROVEEDOR_ID);
  });

  test("rechaza un proveedor que no es UUID", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ proveedorId: "no-es-uuid" })),
    ).toThrow(/proveedor/i);
  });
});

describe("validarDatosMovimiento — datos que no se aceptan del body", () => {
  test("ignora un comercioId mezclado en los datos", () => {
    expect(
      validarDatosMovimiento(movimiento({ comercioId: "otro-comercio" })),
    ).not.toHaveProperty("comercioId");
  });

  test("ignora un usuarioId mezclado en los datos", () => {
    expect(
      validarDatosMovimiento(movimiento({ usuarioId: "otro-usuario" })),
    ).not.toHaveProperty("usuarioId");
  });

  test("ignora un transferenciaId mezclado en los datos", () => {
    expect(
      validarDatosMovimiento(movimiento({ transferenciaId: PROVEEDOR_ID })),
    ).not.toHaveProperty("transferenciaId");
  });
});
