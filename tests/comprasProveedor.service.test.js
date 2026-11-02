import { describe, expect, test } from "@jest/globals";
import { validarFiltrosCompras } from "../src/services/comprasProveedor.service.js";

/**
 * Unitario puro de la validacion de filtros de HU-21 — no toca la base, igual
 * que `validarFiltrosHistorial` en tests/movimientos.service.test.js. El resto
 * (la query, el 404 del proveedor, el resumen) se cubre en
 * tests/comprasProveedor.test.js, que si necesita datos reales.
 */

const DESDE = "2026-01-01T03:00:00.000Z";
const HASTA = "2026-12-31T02:59:59.999Z";

describe("validarFiltrosCompras — defaults", () => {
  test("sin query no hay periodo y la paginacion toma sus defaults", () => {
    expect(validarFiltrosCompras()).toEqual({
      desde: undefined,
      hasta: undefined,
      pagina: 1,
      limite: 50,
    });
  });

  test("una cadena vacia es lo mismo que no mandar el parametro", () => {
    expect(validarFiltrosCompras({ desde: "", hasta: "", limite: "" })).toEqual({
      desde: undefined,
      hasta: undefined,
      pagina: 1,
      limite: 50,
    });
  });
});

describe("validarFiltrosCompras — periodo", () => {
  test("acepta un rango ISO con zona y lo devuelve como Date", () => {
    const filtros = validarFiltrosCompras({ desde: DESDE, hasta: HASTA });

    expect(filtros.desde).toEqual(new Date(DESDE));
    expect(filtros.hasta).toEqual(new Date(HASTA));
  });

  test("acepta un offset y no solo Z", () => {
    expect(
      validarFiltrosCompras({ desde: "2026-01-01T00:00:00-03:00" }).desde,
    ).toEqual(new Date("2026-01-01T03:00:00.000Z"));
  });

  test("periodo abierto: solo desde", () => {
    const filtros = validarFiltrosCompras({ desde: DESDE });

    expect(filtros.desde).toEqual(new Date(DESDE));
    expect(filtros.hasta).toBeUndefined();
  });

  test("periodo abierto: solo hasta", () => {
    const filtros = validarFiltrosCompras({ hasta: HASTA });

    expect(filtros.desde).toBeUndefined();
    expect(filtros.hasta).toEqual(new Date(HASTA));
  });

  test("desde igual a hasta es valido: es una ventana de un instante", () => {
    const filtros = validarFiltrosCompras({ desde: DESDE, hasta: DESDE });

    expect(filtros.desde).toEqual(filtros.hasta);
  });

  // La zona es obligatoria a proposito: "del 10 al 12" depende de donde este
  // parado el usuario, asi que los limites los resuelve el cliente.
  test("rechaza una fecha sin zona", () => {
    expect(() => validarFiltrosCompras({ desde: "2026-01-01T00:00:00" })).toThrow(
      /ISO 8601 con zona/,
    );
  });

  test("rechaza una fecha sin hora", () => {
    expect(() => validarFiltrosCompras({ desde: "2026-01-01" })).toThrow(
      /ISO 8601 con zona/,
    );
  });

  test("rechaza una fecha que no es fecha", () => {
    expect(() => validarFiltrosCompras({ hasta: "ayer" })).toThrow(
      /ISO 8601 con zona/,
    );
  });

  // Un dia que no existe pero con formato valido NO se rechaza: `new Date` lo
  // rota al mes siguiente, igual que en el historial de HU-14, que usa el mismo
  // lector. Queda anotado para que nadie lea el 400 de arriba como "valida el
  // calendario": corre el limite del periodo unos dias, no falla.
  test("una fecha inexistente con formato valido rota al dia siguiente", () => {
    expect(validarFiltrosCompras({ desde: "2026-02-31T00:00:00Z" }).desde).toEqual(
      new Date("2026-03-03T00:00:00.000Z"),
    );
  });

  test("rechaza desde posterior a hasta", () => {
    expect(() =>
      validarFiltrosCompras({ desde: HASTA, hasta: DESDE }),
    ).toThrow(/no puede ser posterior/);
  });

  test("el 400 viaja en el status del error de negocio", () => {
    let error;

    try {
      validarFiltrosCompras({ desde: "2026-01-01" });
    } catch (lanzado) {
      error = lanzado;
    }

    expect(error?.status).toBe(400);
  });
});

describe("validarFiltrosCompras — paginacion", () => {
  test("acepta pagina y limite como strings de la query", () => {
    expect(validarFiltrosCompras({ pagina: "3", limite: "20" })).toMatchObject({
      pagina: 3,
      limite: 20,
    });
  });

  test("el limite maximo se acepta tal cual", () => {
    expect(validarFiltrosCompras({ limite: "200" }).limite).toBe(200);
  });

  // Se recorta en vez de rechazar, igual que HU-14: pedir de mas no es un error
  // del usuario, el tope solo protege a la base.
  test("un limite por encima del maximo se recorta a 200", () => {
    expect(validarFiltrosCompras({ limite: "201" }).limite).toBe(200);
    expect(validarFiltrosCompras({ limite: "99999" }).limite).toBe(200);
  });

  test("rechaza limite 0 y pagina 0", () => {
    expect(() => validarFiltrosCompras({ limite: "0" })).toThrow(
      /"limite" debe ser un número entero mayor a 0/,
    );
    expect(() => validarFiltrosCompras({ pagina: "0" })).toThrow(
      /"pagina" debe ser un número entero mayor a 0/,
    );
  });

  // `Number(...)` solo aceptaria estos tres y dejaria pasar un limite que no
  // es lo que el cliente cree que pidio.
  test.each(["1e3", " 5 ", "0x10", "-1", "1.5", "abc"])(
    "rechaza el limite %p",
    (valor) => {
      expect(() => validarFiltrosCompras({ limite: valor })).toThrow(
        /número entero mayor a 0/,
      );
    },
  );
});

describe("validarFiltrosCompras — lo que no se acepta", () => {
  // El tipo es fijo (`compra`) y el proveedor sale del path. Un campo de mas en
  // la query no puede cambiar de que libro se esta hablando.
  test("descarta tipo, proveedorId, productoId, ubicacionId y comercioId", () => {
    const filtros = validarFiltrosCompras({
      tipo: "venta",
      proveedorId: "123e4567-e89b-12d3-a456-426614174000",
      productoId: "123e4567-e89b-12d3-a456-426614174001",
      ubicacionId: "123e4567-e89b-12d3-a456-426614174002",
      comercioId: "123e4567-e89b-12d3-a456-426614174003",
    });

    expect(Object.keys(filtros).sort()).toEqual([
      "desde",
      "hasta",
      "limite",
      "pagina",
    ]);
  });
});
