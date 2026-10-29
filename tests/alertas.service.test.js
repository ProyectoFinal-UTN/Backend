import { describe, expect, test } from "@jest/globals";
import { hayQueReponer } from "../src/services/alertas.service.js";
import { validarFiltrosAlertas } from "../src/services/alertasActivas.service.js";

/**
 * Unitario puro de HU-17 (SCRUM-128): la regla de cuando un producto esta en
 * falta y la validacion de la paginacion del listado. No toca la base; la
 * generacion, la resolucion y el endpoint estan en tests/alertas.test.js.
 *
 * `hayQueReponer` reemplaza al `cruzoElUmbral` de HU-18, que comparaba una
 * transicion (venia de arriba y quedo abajo). Aca se mira el estado y nada
 * mas: el "no repetir" ya no es cosa de esta funcion sino del indice unico
 * parcial de la tabla `alerta`.
 */

describe("hayQueReponer — cuándo un producto está en falta", () => {
  test("por debajo del umbral hay que reponer", () => {
    expect(hayQueReponer({ enStock: 3, umbralMinimo: 10 })).toBe(true);
  });

  test("justo en el umbral también: alcanzar el mínimo ya es reponer", () => {
    expect(hayQueReponer({ enStock: 10, umbralMinimo: 10 })).toBe(true);
  });

  test("una unidad por encima del umbral todavía no", () => {
    expect(hayQueReponer({ enStock: 11, umbralMinimo: 10 })).toBe(false);
  });

  test("muy por encima del umbral no", () => {
    expect(hayQueReponer({ enStock: 200, umbralMinimo: 10 })).toBe(false);
  });

  test("sin stock y con umbral configurado, sí", () => {
    expect(hayQueReponer({ enStock: 0, umbralMinimo: 1 })).toBe(true);
  });

  test("umbral 0 es «sin umbral configurado»: nunca, aunque no quede nada", () => {
    expect(hayQueReponer({ enStock: 0, umbralMinimo: 0 })).toBe(false);
  });
});

describe("validarFiltrosAlertas — paginación", () => {
  test("sin query usa los valores por defecto del resto de la API", () => {
    expect(validarFiltrosAlertas()).toEqual({ pagina: 1, limite: 50 });
  });

  test("toma pagina y limite de la query", () => {
    expect(validarFiltrosAlertas({ pagina: "3", limite: "20" })).toEqual({
      pagina: 3,
      limite: 20,
    });
  });

  test("un límite mayor al máximo se recorta, no se rechaza", () => {
    expect(validarFiltrosAlertas({ limite: "5000" }).limite).toBe(200);
  });

  test("descarta lo que no es paginación: el comercio sale de la sesión", () => {
    expect(
      validarFiltrosAlertas({ comercioId: "otro", estado: "resuelta" }),
    ).toEqual({ pagina: 1, limite: 50 });
  });

  test("pagina 0 es un error", () => {
    expect(() => validarFiltrosAlertas({ pagina: "0" })).toThrow();
  });

  test("un límite que no es un entero es un error", () => {
    expect(() => validarFiltrosAlertas({ limite: "abc" })).toThrow();
  });

  test("la notación exponencial no cuela como entero", () => {
    expect(() => validarFiltrosAlertas({ limite: "1e3" })).toThrow();
  });
});
