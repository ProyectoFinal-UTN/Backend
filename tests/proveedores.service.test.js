import { describe, expect, test } from "@jest/globals";
import { validarDatosProveedor } from "../src/services/proveedores.service.js";

/**
 * Unitario puro de la validacion de HU-19 — no toca la base, igual que
 * `tests/productos.service.test.js`. El resto de la logica de proveedores (que
 * si toca la base) se cubre en `tests/proveedores.test.js`.
 */

const DATOS_COMPLETOS = {
  nombre: "Distribuidora Sur",
  contacto: "Laura Gómez",
  telefono: "11 5555-0000",
  correo: "ventas@distrisur.com",
  rubro: "Bebidas",
  condicionesPago: "30 días",
};

describe("validarDatosProveedor — alta (no parcial)", () => {
  test("acepta datos completos y recorta espacios", () => {
    const resultado = validarDatosProveedor({
      ...DATOS_COMPLETOS,
      nombre: "  Distribuidora Sur  ",
      rubro: " Bebidas ",
    });

    expect(resultado).toEqual(DATOS_COMPLETOS);
  });

  test("con solo el nombre alcanza: el resto queda en null", () => {
    expect(validarDatosProveedor({ nombre: "Distribuidora Sur" })).toEqual({
      nombre: "Distribuidora Sur",
      contacto: null,
      telefono: null,
      correo: null,
      rubro: null,
      condicionesPago: null,
    });
  });

  test("un opcional vacío o solo espacios se guarda como null, no como texto vacío", () => {
    const resultado = validarDatosProveedor({
      nombre: "Distribuidora Sur",
      contacto: "",
      rubro: "   ",
    });

    expect(resultado.contacto).toBeNull();
    expect(resultado.rubro).toBeNull();
  });

  test.each([undefined, "", "   ", null, 123])(
    "rechaza el nombre %p",
    (nombre) => {
      expect(() => validarDatosProveedor({ nombre })).toThrow(/nombre/i);
    },
  );

  test("rechaza un nombre de más de 150 caracteres", () => {
    expect(() => validarDatosProveedor({ nombre: "a".repeat(151) })).toThrow(
      /nombre/i,
    );
  });

  test("acepta un nombre de exactamente 150 caracteres", () => {
    expect(validarDatosProveedor({ nombre: "a".repeat(150) }).nombre).toHaveLength(
      150,
    );
  });

  test.each([
    ["contacto", 150, /contacto/i],
    ["telefono", 40, /teléfono/i],
    ["rubro", 100, /rubro/i],
    ["condicionesPago", 255, /condiciones de pago/i],
  ])("rechaza %s de más de %i caracteres", (campo, maximo, mensaje) => {
    expect(() =>
      validarDatosProveedor({ nombre: "X", [campo]: "a".repeat(maximo + 1) }),
    ).toThrow(mensaje);

    expect(
      validarDatosProveedor({ nombre: "X", [campo]: "a".repeat(maximo) })[campo],
    ).toHaveLength(maximo);
  });

  test("el tope se mide después de recortar espacios", () => {
    const resultado = validarDatosProveedor({
      nombre: "X",
      telefono: `  ${"1".repeat(40)}  `,
    });

    expect(resultado.telefono).toHaveLength(40);
  });

  test("rechaza un opcional que no es texto, en vez de convertirlo", () => {
    expect(() =>
      validarDatosProveedor({ nombre: "X", telefono: 1155550000 }),
    ).toThrow(/teléfono.*texto/i);
    expect(() =>
      validarDatosProveedor({ nombre: "X", rubro: ["Bebidas"] }),
    ).toThrow(/rubro.*texto/i);
  });

  test.each(["juan", "juan@", "juan@dominio", "@dominio.com", "juan @x.com"])(
    "rechaza el correo %p",
    (correo) => {
      expect(() => validarDatosProveedor({ nombre: "X", correo })).toThrow(
        /correo/i,
      );
    },
  );

  test("rechaza un correo de más de 255 caracteres", () => {
    const correo = `${"a".repeat(250)}@x.com`;

    expect(() => validarDatosProveedor({ nombre: "X", correo })).toThrow(
      /correo/i,
    );
  });

  test("los errores son 400", () => {
    try {
      validarDatosProveedor({});
      throw new Error("no lanzó");
    } catch (error) {
      expect(error.status).toBe(400);
    }
  });
});

describe("validarDatosProveedor — edición (parcial)", () => {
  test("valida y devuelve solo los campos presentes", () => {
    expect(
      validarDatosProveedor({ rubro: "Limpieza" }, { parcial: true }),
    ).toEqual({ rubro: "Limpieza" });
  });

  test("un objeto vacío no devuelve nada (el service responde 400)", () => {
    expect(validarDatosProveedor({}, { parcial: true })).toEqual({});
  });

  test("null o vacío en un opcional lo borra", () => {
    expect(
      validarDatosProveedor({ correo: null, telefono: "" }, { parcial: true }),
    ).toEqual({ correo: null, telefono: null });
  });

  test("el nombre no se puede vaciar en la edición", () => {
    expect(() =>
      validarDatosProveedor({ nombre: "" }, { parcial: true }),
    ).toThrow(/nombre/i);
    expect(() =>
      validarDatosProveedor({ nombre: null }, { parcial: true }),
    ).toThrow(/nombre/i);
  });

  test("ignora campos que no son del proveedor", () => {
    expect(
      validarDatosProveedor(
        { rubro: "Limpieza", comercioId: "otro", activo: false, id: "x" },
        { parcial: true },
      ),
    ).toEqual({ rubro: "Limpieza" });
  });
});
