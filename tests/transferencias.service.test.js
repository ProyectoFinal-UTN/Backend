import { describe, expect, test } from "@jest/globals";
import { validarDatosTransferencia } from "../src/services/transferencias.service.js";

/**
 * Unitario puro de la validacion de HU-12 — no toca la base, igual que
 * `tests/movimientos.service.test.js` con `validarDatosMovimiento`. La
 * transaccion, el stock insuficiente, la atomicidad y el aislamiento entre
 * comercios se cubren en `tests/transferencias.test.js`, que si necesita datos
 * reales.
 */

const PRODUCTO_ID = "123e4567-e89b-12d3-a456-426614174000";
const ORIGEN_ID = "223e4567-e89b-12d3-a456-426614174001";
const DESTINO_ID = "323e4567-e89b-12d3-a456-426614174002";

function transferencia(overrides = {}) {
  return {
    productoId: PRODUCTO_ID,
    ubicacionOrigenId: ORIGEN_ID,
    ubicacionDestinoId: DESTINO_ID,
    cantidad: 5,
    ...overrides,
  };
}

/** Ejecuta el validador y devuelve el error que tiro, para poder mirar status. */
function errorDe(datos) {
  try {
    validarDatosTransferencia(datos);
  } catch (error) {
    return error;
  }

  throw new Error("Se esperaba que la validación fallara y no falló");
}

describe("validarDatosTransferencia — datos válidos", () => {
  test("devuelve la cantidad como magnitud positiva, sin signo", () => {
    expect(validarDatosTransferencia(transferencia()).cantidad).toBe(5);
  });

  test("devuelve las dos ubicaciones y el producto", () => {
    const datos = validarDatosTransferencia(transferencia());

    expect(datos.productoId).toBe(PRODUCTO_ID);
    expect(datos.ubicacionOrigenId).toBe(ORIGEN_ID);
    expect(datos.ubicacionDestinoId).toBe(DESTINO_ID);
  });

  test("sin motivo, guarda null y no una cadena vacía", () => {
    expect(validarDatosTransferencia(transferencia()).motivo).toBeNull();
  });

  test("un motivo en blanco es lo mismo que no mandarlo", () => {
    expect(
      validarDatosTransferencia(transferencia({ motivo: "   " })).motivo,
    ).toBeNull();
  });

  test("el motivo se recorta", () => {
    expect(
      validarDatosTransferencia(transferencia({ motivo: "  Reposición  " }))
        .motivo,
    ).toBe("Reposición");
  });

  test("descarta un comercioId o un usuarioId inyectados en el body", () => {
    const datos = validarDatosTransferencia(
      transferencia({ comercioId: "otro", usuarioId: "otro" }),
    );

    expect(datos.comercioId).toBeUndefined();
    expect(datos.usuarioId).toBeUndefined();
  });
});

describe("validarDatosTransferencia — ubicaciones", () => {
  test("origen y destino no pueden ser la misma", () => {
    const error = errorDe(transferencia({ ubicacionDestinoId: ORIGEN_ID }));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/distintas/i);
  });

  // Postgres trata el uuid sin distinguir mayusculas: 'AAAA...' y 'aaaa...' son
  // la misma ubicacion. Si el validador los comparara tal como llegan, los
  // veria distintos, la transferencia pasaria hasta el INSERT y el CHECK de la
  // tabla la cortaria con un 500 en vez de este 400.
  test("el mismo id en distinta capitalización cuenta como la misma ubicación", () => {
    const error = errorDe(
      transferencia({
        ubicacionOrigenId: ORIGEN_ID,
        ubicacionDestinoId: ORIGEN_ID.toUpperCase(),
      }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/distintas/i);
  });

  test("devuelve los ids normalizados en minúscula", () => {
    const datos = validarDatosTransferencia(
      transferencia({
        productoId: PRODUCTO_ID.toUpperCase(),
        ubicacionOrigenId: ORIGEN_ID.toUpperCase(),
        ubicacionDestinoId: DESTINO_ID.toUpperCase(),
      }),
    );

    expect(datos.productoId).toBe(PRODUCTO_ID);
    expect(datos.ubicacionOrigenId).toBe(ORIGEN_ID);
    expect(datos.ubicacionDestinoId).toBe(DESTINO_ID);
  });

  test("falta el origen: 400 y no 404, porque es un dato que no se mandó", () => {
    const error = errorDe(transferencia({ ubicacionOrigenId: undefined }));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/origen y la de destino/i);
  });

  test("falta el destino: 400", () => {
    expect(errorDe(transferencia({ ubicacionDestinoId: null })).status).toBe(
      400,
    );
  });

  // Mismo criterio que HU-13: un id que no es UUID se responde como
  // "no existe", porque decir "existe pero no es tuya" filtraria informacion.
  test("una ubicación que no es UUID da 404, no 400", () => {
    expect(errorDe(transferencia({ ubicacionOrigenId: "1" })).status).toBe(404);
    expect(errorDe(transferencia({ ubicacionDestinoId: "1" })).status).toBe(404);
  });
});

describe("validarDatosTransferencia — producto y cantidad", () => {
  test("un producto que no es UUID da 400", () => {
    const error = errorDe(transferencia({ productoId: "no-es-uuid" }));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/producto/i);
  });

  test.each([
    ["cero", 0],
    ["negativa", -3],
    ["decimal", 2.5],
    ["cadena", "5"],
    ["booleana", true],
    ["arreglo", [5]],
    ["nula", null],
    ["ausente", undefined],
    ["mayor al máximo de un integer", 2147483648],
  ])("una cantidad %s se rechaza con 400", (_etiqueta, cantidad) => {
    expect(errorDe(transferencia({ cantidad })).status).toBe(400);
  });

  test("el máximo exacto de un integer se acepta", () => {
    expect(
      validarDatosTransferencia(transferencia({ cantidad: 2147483647 }))
        .cantidad,
    ).toBe(2147483647);
  });

  test("un motivo de más de 255 caracteres da 400", () => {
    const error = errorDe(transferencia({ motivo: "a".repeat(256) }));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/255/);
  });

  test("un motivo de exactamente 255 caracteres se acepta", () => {
    expect(
      validarDatosTransferencia(transferencia({ motivo: "a".repeat(255) }))
        .motivo,
    ).toHaveLength(255);
  });
});
