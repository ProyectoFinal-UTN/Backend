import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  MODELOS_PERMITIDOS,
  estimarCostoUsd,
  resolverModelo,
} from "../src/lib/llm.js";

/**
 * Unitarios del candado de costos del adaptador de LLM (HU-26).
 *
 * La cuenta del AI Gateway es una sola para los tres integrantes, con 5 USD de
 * credito por mes. Estos tests cuidan lo que impide gastarlo por accidente: que
 * un `LLM_MODELO` caro en el .env de alguien no llegue nunca al proveedor.
 *
 * Son puros: no llaman al Gateway ni necesitan key.
 */

const DEFAULT = "google/gemini-2.5-flash";

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("resolverModelo — candado de modelos", () => {
  test("sin LLM_MODELO usa el default barato", () => {
    expect(resolverModelo(undefined)).toBe(DEFAULT);
    expect(resolverModelo("")).toBe(DEFAULT);
  });

  test("respeta un modelo que está en la lista", () => {
    expect(resolverModelo("google/gemini-2.5-flash-lite")).toBe(
      "google/gemini-2.5-flash-lite",
    );
  });

  test("un modelo caro cae al default y nunca llega al proveedor", () => {
    // El caso que motiva el candado: alguien quiere "probar algo mejor" y se
    // come el crédito de los tres en una tarde.
    expect(resolverModelo("anthropic/claude-opus-4")).toBe(DEFAULT);
    expect(resolverModelo("openai/gpt-5")).toBe(DEFAULT);
    expect(resolverModelo("google/gemini-2.5-pro")).toBe(DEFAULT);
  });

  test("un typo también cae al default en vez de romper", () => {
    expect(resolverModelo("gemini-2.5-flash")).toBe(DEFAULT);
  });

  test("no se deja engañar por propiedades heredadas del objeto", () => {
    // `MODELOS_PERMITIDOS["toString"]` existe en cualquier objeto de JS. Con
    // un `if (MODELOS_PERMITIDOS[pedido])` ingenuo, "toString" pasaría el
    // candado y llegaría al proveedor como nombre de modelo.
    expect(resolverModelo("toString")).toBe(DEFAULT);
    expect(resolverModelo("__proto__")).toBe(DEFAULT);
  });
});

describe("MODELOS_PERMITIDOS — techo de precio", () => {
  test("ningún modelo de la lista supera 2,50 USD por millón de salida", () => {
    // Si alguien agrega un modelo a la lista, este test lo obliga a que sea
    // barato, o a cambiar el techo a sabiendas y con el equipo de acuerdo.
    const caros = Object.entries(MODELOS_PERMITIDOS)
      .filter(([, precio]) => precio.salida > 2.5)
      .map(([modelo]) => modelo);

    // Si falla, el mensaje nombra el modelo que se coló.
    expect(caros).toEqual([]);
  });

  test("el default está en la lista", () => {
    expect(Object.hasOwn(MODELOS_PERMITIDOS, DEFAULT)).toBe(true);
  });
});

describe("estimarCostoUsd", () => {
  test("calcula entrada y salida con el precio por millón", () => {
    // gemini-2.5-flash: 0,30 entrada y 2,50 salida por millón.
    // 1.000.000 de entrada + 1.000.000 de salida = 0,30 + 2,50.
    expect(
      estimarCostoUsd(DEFAULT, { entrada: 1_000_000, salida: 1_000_000 }),
    ).toBeCloseTo(2.8);
  });

  test("una consulta típica cuesta fracciones de centavo", () => {
    const costo = estimarCostoUsd(DEFAULT, { entrada: 2500, salida: 200 });

    expect(costo).toBeCloseTo(0.00125);
  });

  test("devuelve 0 para un modelo fuera de la lista", () => {
    expect(
      estimarCostoUsd("anthropic/claude-opus-4", { entrada: 1000, salida: 1000 }),
    ).toBe(0);
  });
});
