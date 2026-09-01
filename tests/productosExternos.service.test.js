import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { buscarEnOpenFoodFacts } from "../src/services/productosExternos.service.js";

/**
 * Unitario puro del prellenado opcional de HU-9 (ver plan §10).
 *
 * A diferencia del resto de HU-9, acá sí corresponde mockear: es un llamado
 * HTTP a un tercero, no a la base propia. Dejarlo pegarle a la red real en
 * cada corrida de CI seria lento y flaky.
 */

const CODIGO = "7790895000782";

function mockearFetch(implementacion) {
  global.fetch = jest.fn(implementacion);
}

beforeEach(() => {
  jest.restoreAllMocks();
});

afterEach(() => {
  delete global.fetch;
});

describe("buscarEnOpenFoodFacts", () => {
  test("mapea nombre y categoria cuando hay match", async () => {
    mockearFetch(async () => ({
      ok: true,
      json: async () => ({
        status: 1,
        product: {
          product_name: "Coca-Cola 500ml",
          categories: "Bebidas,Gaseosas,Bebidas con azúcar",
        },
      }),
    }));

    const resultado = await buscarEnOpenFoodFacts(CODIGO);

    expect(resultado).toEqual({ nombre: "Coca-Cola 500ml", categoria: "Bebidas" });
    expect(global.fetch).toHaveBeenCalledWith(
      `https://world.openfoodfacts.org/api/v2/product/${CODIGO}.json`,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  test("devuelve null cuando Open Food Facts no tiene el producto (status 0)", async () => {
    mockearFetch(async () => ({
      ok: true,
      json: async () => ({ status: 0 }),
    }));

    expect(await buscarEnOpenFoodFacts(CODIGO)).toBeNull();
  });

  test("devuelve null cuando la respuesta HTTP no es ok (404 u otro)", async () => {
    mockearFetch(async () => ({ ok: false, status: 404 }));

    expect(await buscarEnOpenFoodFacts(CODIGO)).toBeNull();
  });

  test("devuelve null ante un timeout o error de red, sin lanzar", async () => {
    mockearFetch(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });

    await expect(buscarEnOpenFoodFacts(CODIGO)).resolves.toBeNull();
  });

  test("devuelve null ante un JSON invalido, sin lanzar", async () => {
    mockearFetch(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }));

    await expect(buscarEnOpenFoodFacts(CODIGO)).resolves.toBeNull();
  });

  test("devuelve null si el producto no trae nombre ni categoria usables", async () => {
    mockearFetch(async () => ({
      ok: true,
      json: async () => ({ status: 1, product: {} }),
    }));

    expect(await buscarEnOpenFoodFacts(CODIGO)).toBeNull();
  });
});