import { describe, expect, test } from "@jest/globals";
import {
  armarAvisoDeReposicion,
  cruzoElUmbral,
  validarBaja,
  validarSuscripcion,
} from "../src/services/push.service.js";

/**
 * Unitario puro de HU-18 (SCRUM-127): la regla de cuando se avisa, el
 * contenido del push y la validacion de la suscripcion. No toca la base ni
 * manda nada; el envio de punta a punta esta en `tests/push.test.js`.
 */

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123";
const P256DH =
  "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const AUTH = "tBHItJI5svbpez7KI4CCXg";

function suscripcion(overrides = {}) {
  return {
    endpoint: ENDPOINT,
    expirationTime: null,
    keys: { p256dh: P256DH, auth: AUTH },
    ...overrides,
  };
}

describe("cruzoElUmbral — cuándo se manda el aviso", () => {
  test("pasar de arriba del umbral a debajo avisa", () => {
    expect(
      cruzoElUmbral({ stockAntes: 14, stockDespues: 3, umbralMinimo: 10 }),
    ).toBe(true);
  });

  test("quedar justo en el umbral avisa: llegar al mínimo ya es reponer", () => {
    expect(
      cruzoElUmbral({ stockAntes: 12, stockDespues: 10, umbralMinimo: 10 }),
    ).toBe(true);
  });

  test("bajar pero quedar por encima no avisa", () => {
    expect(
      cruzoElUmbral({ stockAntes: 20, stockDespues: 15, umbralMinimo: 10 }),
    ).toBe(false);
  });

  test("si ya estaba por debajo no se repite", () => {
    expect(
      cruzoElUmbral({ stockAntes: 8, stockDespues: 7, umbralMinimo: 10 }),
    ).toBe(false);
  });

  test("si ya estaba justo en el umbral tampoco se repite", () => {
    expect(
      cruzoElUmbral({ stockAntes: 10, stockDespues: 4, umbralMinimo: 10 }),
    ).toBe(false);
  });

  test("sin umbral configurado (0) no avisa nunca, aunque se quede sin stock", () => {
    expect(
      cruzoElUmbral({ stockAntes: 5, stockDespues: 0, umbralMinimo: 0 }),
    ).toBe(false);
  });

  test("una entrada no avisa", () => {
    expect(
      cruzoElUmbral({ stockAntes: 3, stockDespues: 30, umbralMinimo: 10 }),
    ).toBe(false);
  });
});

describe("armarAvisoDeReposicion — contenido del push", () => {
  test("arma el payload del contrato con el Frontend", () => {
    expect(
      armarAvisoDeReposicion({
        productoId: "123e4567-e89b-12d3-a456-426614174000",
        nombre: "Yerba 1 kg",
        stockActual: 3,
        umbralMinimo: 10,
      }),
    ).toEqual({
      tipo: "alerta_reposicion",
      titulo: "Reponer: Yerba 1 kg",
      cuerpo: "Stock actual: 3 (mínimo 10)",
      productoId: "123e4567-e89b-12d3-a456-426614174000",
      stockActual: 3,
      umbralMinimo: 10,
    });
  });
});

describe("validarSuscripcion", () => {
  test("acepta lo que devuelve PushSubscription.toJSON()", () => {
    expect(validarSuscripcion(suscripcion())).toEqual({
      endpoint: ENDPOINT,
      p256dh: P256DH,
      auth: AUTH,
      expiraEn: null,
    });
  });

  test("convierte expirationTime (milisegundos) en fecha", () => {
    const datos = validarSuscripcion(suscripcion({ expirationTime: 1800000000000 }));
    expect(datos.expiraEn).toEqual(new Date(1800000000000));
  });

  test("descarta lo que no es de la suscripción: usuario y comercio salen de la sesión", () => {
    const datos = validarSuscripcion(
      suscripcion({ usuarioId: "otro", comercioId: "otro" }),
    );
    expect(datos).not.toHaveProperty("usuarioId");
    expect(datos).not.toHaveProperty("comercioId");
  });

  test.each([
    ["sin body", undefined],
    ["body null", null],
    ["sin endpoint", suscripcion({ endpoint: undefined })],
    ["endpoint vacío", suscripcion({ endpoint: "   " })],
    ["endpoint que no es URL", suscripcion({ endpoint: "no-es-una-url" })],
    ["endpoint http", suscripcion({ endpoint: "http://push.example.com/x" })],
    ["endpoint demasiado largo", suscripcion({ endpoint: `https://x.com/${"a".repeat(2100)}` })],
    ["sin keys", suscripcion({ keys: undefined })],
    ["keys como texto", suscripcion({ keys: "abc" })],
    ["sin p256dh", suscripcion({ keys: { auth: AUTH } })],
    ["sin auth", suscripcion({ keys: { p256dh: P256DH } })],
    ["clave con caracteres inválidos", suscripcion({ keys: { p256dh: "no válida!", auth: AUTH } })],
    ["expirationTime como texto", suscripcion({ expirationTime: "mañana" })],
  ])("%s → 400", (_caso, body) => {
    expect(() => validarSuscripcion(body)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("validarBaja", () => {
  test("acepta un endpoint https", () => {
    expect(validarBaja({ endpoint: ENDPOINT })).toEqual({ endpoint: ENDPOINT });
  });

  test.each([
    ["sin body", undefined],
    ["sin endpoint", {}],
    ["endpoint http", { endpoint: "http://push.example.com/x" }],
  ])("%s → 400", (_caso, body) => {
    expect(() => validarBaja(body)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
