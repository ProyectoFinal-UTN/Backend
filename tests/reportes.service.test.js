import { describe, expect, test } from "@jest/globals";
import {
  ZONA_HORARIA_POR_DEFECTO,
  calcularTotales,
  nombreDeArchivo,
  validarParametrosReporte,
} from "../src/services/reportes.service.js";

/**
 * Unitario puro de HU-25 — no toca la base, igual que
 * tests/comprasProveedor.service.test.js. La query, los 404 y el PDF de punta a
 * punta se cubren en tests/reportes.test.js, que si necesita datos reales.
 */

const DESDE = "2026-09-01T03:00:00.000Z";
const HASTA = "2026-10-01T02:59:59.999Z";
const UUID = "123e4567-e89b-12d3-a456-426614174000";

const periodo = (extra = {}) => ({
  tipo: "periodo",
  desde: DESDE,
  hasta: HASTA,
  ...extra,
});

/** El mensaje del ErrorDeNegocio que tira la validacion, con su status. */
function errorDe(query) {
  try {
    validarParametrosReporte(query);
  } catch (error) {
    return { status: error.status, mensaje: error.message };
  }
  throw new Error("La validación no tiró");
}

describe("validarParametrosReporte — casos válidos", () => {
  test("período: normaliza el rango a Date y toma la zona por defecto", () => {
    expect(validarParametrosReporte(periodo())).toEqual({
      tipo: "periodo",
      desde: new Date(DESDE),
      hasta: new Date(HASTA),
      productoId: undefined,
      proveedorId: undefined,
      zonaHoraria: ZONA_HORARIA_POR_DEFECTO,
    });
  });

  test("producto y proveedor llevan su id", () => {
    expect(
      validarParametrosReporte(periodo({ tipo: "producto", productoId: UUID }))
        .productoId,
    ).toBe(UUID);
    expect(
      validarParametrosReporte(
        periodo({ tipo: "proveedor", proveedorId: UUID }),
      ).proveedorId,
    ).toBe(UUID);
  });

  test("el tipo no distingue mayúsculas ni espacios", () => {
    expect(validarParametrosReporte(periodo({ tipo: " Periodo " })).tipo).toBe(
      "periodo",
    );
  });

  test("acepta otra zona horaria IANA", () => {
    expect(
      validarParametrosReporte(periodo({ zonaHoraria: "UTC" })).zonaHoraria,
    ).toBe("UTC");
  });

  test("desde y hasta iguales es un rango válido", () => {
    expect(() =>
      validarParametrosReporte(periodo({ hasta: DESDE })),
    ).not.toThrow();
  });

  test("no deja pasar un comercioId que venga en la query", () => {
    expect(
      validarParametrosReporte(periodo({ comercioId: UUID })),
    ).not.toHaveProperty("comercioId");
  });
});

describe("validarParametrosReporte — tipo", () => {
  test.each([undefined, ""])("sin tipo (%p) es 400 y lista los aceptados", (tipo) => {
    expect(errorDe(periodo({ tipo }))).toEqual({
      status: 400,
      mensaje:
        'Falta el parámetro "tipo". Los aceptados son: periodo, producto, proveedor',
    });
  });

  test.each(["ubicacion", ["periodo", "producto"]])(
    "un tipo desconocido (%p) es 400",
    (tipo) => {
      expect(errorDe(periodo({ tipo }))).toEqual({
        status: 400,
        mensaje:
          "El tipo de reporte no es válido. Los aceptados son: periodo, producto, proveedor",
      });
    },
  );
});

describe("validarParametrosReporte — rango", () => {
  test.each(["desde", "hasta"])("sin %s es 400", (nombre) => {
    expect(errorDe(periodo({ [nombre]: undefined }))).toEqual({
      status: 400,
      mensaje: `Falta el parámetro "${nombre}": el reporte necesita un rango de fechas`,
    });
  });

  test.each(["2026-09-01", "2026-09-01T00:00:00", "ayer"])(
    "una fecha sin zona o sin formato ISO (%p) es 400",
    (desde) => {
      expect(errorDe(periodo({ desde })).status).toBe(400);
      expect(errorDe(periodo({ desde })).mensaje).toContain(
        'El parámetro "desde" debe ser una fecha y hora ISO 8601 con zona',
      );
    },
  );

  test("desde posterior a hasta es 400", () => {
    expect(errorDe(periodo({ desde: HASTA, hasta: DESDE }))).toEqual({
      status: 400,
      mensaje: 'La fecha "desde" no puede ser posterior a la fecha "hasta"',
    });
  });
});

describe("validarParametrosReporte — producto y proveedor", () => {
  test("el reporte por producto exige productoId", () => {
    expect(errorDe(periodo({ tipo: "producto" }))).toEqual({
      status: 400,
      mensaje:
        'Falta el parámetro "productoId": el reporte por producto lo necesita',
    });
  });

  test("el reporte por proveedor exige proveedorId", () => {
    expect(errorDe(periodo({ tipo: "proveedor" }))).toEqual({
      status: 400,
      mensaje:
        'Falta el parámetro "proveedorId": el reporte por proveedor lo necesita',
    });
  });

  test("un productoId en un reporte que no es por producto se rechaza, no se ignora", () => {
    expect(errorDe(periodo({ productoId: UUID }))).toEqual({
      status: 400,
      mensaje:
        'El parámetro "productoId" solo se usa en el reporte por producto',
    });
    expect(
      errorDe(periodo({ tipo: "producto", productoId: UUID, proveedorId: UUID })),
    ).toEqual({
      status: 400,
      mensaje:
        'El parámetro "proveedorId" solo se usa en el reporte por proveedor',
    });
  });

  // El UUID se valida al buscarlo, para que sea el mismo 404 que un id que no
  // existe (ver tests/reportes.test.js).
  test("un id con formato inválido pasa la validación y lo resuelve la búsqueda", () => {
    expect(
      validarParametrosReporte(periodo({ tipo: "producto", productoId: "x" }))
        .productoId,
    ).toBe("x");
  });
});

describe("validarParametrosReporte — zona horaria", () => {
  test("una zona que no existe es 400", () => {
    expect(errorDe(periodo({ zonaHoraria: "Marte/Olympus" }))).toEqual({
      status: 400,
      mensaje: `La zona horaria no es válida. Tiene que ser un nombre IANA, por ejemplo ${ZONA_HORARIA_POR_DEFECTO}`,
    });
  });
});

describe("calcularTotales", () => {
  test("separa entradas y salidas, saca el neto y desglosa por tipo", () => {
    expect(
      calcularTotales([
        { tipo: "venta", cantidad: -2 },
        { tipo: "compra", cantidad: 7 },
        { tipo: "compra", cantidad: 3 },
        { tipo: "merma", cantidad: -1 },
      ]),
    ).toEqual({
      movimientos: 4,
      entradas: 10,
      salidas: 3,
      neto: 7,
      // En el orden del enum, no en el de aparición.
      porTipo: [
        { tipo: "compra", movimientos: 2, unidades: 10 },
        { tipo: "venta", movimientos: 1, unidades: -2 },
        { tipo: "merma", movimientos: 1, unidades: -1 },
      ],
    });
  });

  test("las dos patas de una transferencia se cancelan en el neto", () => {
    const totales = calcularTotales([
      { tipo: "transferencia", cantidad: -4 },
      { tipo: "transferencia", cantidad: 4 },
    ]);

    expect(totales).toMatchObject({ entradas: 4, salidas: 4, neto: 0 });
    expect(totales.porTipo).toEqual([
      { tipo: "transferencia", movimientos: 2, unidades: 0 },
    ]);
  });

  test("sin movimientos todo da cero", () => {
    expect(calcularTotales([])).toEqual({
      movimientos: 0,
      entradas: 0,
      salidas: 0,
      neto: 0,
      porTipo: [],
    });
  });
});

describe("nombreDeArchivo", () => {
  const parametros = validarParametrosReporte(periodo());

  test("lleva el tipo y el rango en fechas locales", () => {
    // `hasta` es 02:59 UTC del 1/10, que en Argentina todavía es el 30/9.
    expect(nombreDeArchivo(parametros)).toBe(
      "reporte-movimientos-periodo-2026-09-01_2026-09-30.pdf",
    );
  });

  test("suma el producto o proveedor sin tildes, ñ ni espacios", () => {
    expect(
      nombreDeArchivo({ ...parametros, tipo: "producto" }, "Yerba Ñandú 1 kg"),
    ).toBe("reporte-movimientos-producto-yerba-nandu-1-kg-2026-09-01_2026-09-30.pdf");
  });

  test("un nombre sin letras ni números no deja un guion colgado", () => {
    expect(nombreDeArchivo({ ...parametros, tipo: "proveedor" }, "★★★")).toBe(
      "reporte-movimientos-proveedor-2026-09-01_2026-09-30.pdf",
    );
  });
});
