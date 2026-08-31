import { describe, expect, test } from "@jest/globals";
import { generarSlug } from "../src/services/comercios.service.js";

describe("generarSlug", () => {
  test("saca tildes y enes", () => {
    expect(generarSlug("Almacén de José")).toMatch(/^almacen-de-jose-[a-f0-9]{8}$/);
    expect(generarSlug("Ñandú")).toMatch(/^nandu-[a-f0-9]{8}$/);
  });

  test("colapsa separadores y no deja guiones sueltos en las puntas", () => {
    expect(generarSlug("  Kiosco   El Sol!!  ")).toMatch(
      /^kiosco-el-sol-[a-f0-9]{8}$/,
    );
  });

  test("dos comercios con el mismo nombre no colisionan", () => {
    // `organization.slug` es unique: si dos slugs iguales se cruzaran, el
    // segundo registro abortaria.
    const a = generarSlug("Despensa Norte");
    const b = generarSlug("Despensa Norte");

    expect(a).not.toBe(b);
    expect(a.slice(0, 15)).toBe(b.slice(0, 15));
  });

  test("un texto sin caracteres utiles no produce un slug vacio", () => {
    expect(generarSlug("!!!")).toMatch(/^comercio-[a-f0-9]{8}$/);
    expect(generarSlug("")).toMatch(/^comercio-[a-f0-9]{8}$/);
  });

  test("recorta los nombres largos y deja lugar para el sufijo", () => {
    const slug = generarSlug("a".repeat(120));
    const [base] = slug.split(/-(?=[a-f0-9]{8}$)/);

    expect(base.length).toBeLessThanOrEqual(40);
  });
});
