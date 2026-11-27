import { describe, expect, test } from "@jest/globals";
import {
  DIAS_MAXIMOS,
  DIAS_MAXIMOS_RANGO,
  DIAS_POR_DEFECTO,
  completarSerie,
  diaEnZona,
  diasDeCobertura,
  resumirCompras,
  validarParametrosKpis,
  ventanaDeDias,
  ventanaDeKpis,
} from "../src/services/kpis.service.js";

/**
 * Tests unitarios de la logica pura de los KPIs (HU-22) y del filtro de periodo
 * (HU-23). Sin base: lo que pasa contra Postgres esta en tests/kpis.test.js.
 */

/** El mensaje del 400, para no comparar contra el objeto Error entero. */
function mensajeDe(fn) {
  try {
    fn();
  } catch (error) {
    return { status: error.status, mensaje: error.message };
  }

  throw new Error("se esperaba un ErrorDeNegocio y no se tiro ninguno");
}

describe("validarParametrosKpis", () => {
  test("sin `dias` usa la ventana por defecto", () => {
    expect(validarParametrosKpis({})).toEqual({ dias: DIAS_POR_DEFECTO });
    expect(validarParametrosKpis()).toEqual({ dias: DIAS_POR_DEFECTO });
  });

  test("acepta un entero positivo", () => {
    expect(validarParametrosKpis({ dias: "7" })).toEqual({ dias: 7 });
  });

  test("recorta lo que pasa del maximo en vez de rechazarlo", () => {
    expect(validarParametrosKpis({ dias: "365" })).toEqual({
      dias: DIAS_MAXIMOS,
    });
  });

  test.each(["0", "-3", "1.5", "1e2", "abc", " 7 "])(
    "rechaza %p con 400",
    (dias) => {
      expect(() => validarParametrosKpis({ dias })).toThrow(
        expect.objectContaining({ status: 400 }),
      );
    },
  );

  test("no deja pasar un comercioId de la query string", () => {
    expect(
      validarParametrosKpis({ dias: "7", comercioId: "otro-comercio" }),
    ).toEqual({ dias: 7 });
  });
});

describe("validarParametrosKpis — rango desde/hasta (HU-23)", () => {
  test("acepta un rango con zona explicita y devuelve instantes", () => {
    const parametros = validarParametrosKpis({
      desde: "2026-03-01T00:00:00.000-03:00",
      hasta: "2026-03-31T23:59:59.000-03:00",
    });

    expect(parametros.desde.toISOString()).toBe("2026-03-01T03:00:00.000Z");
    expect(parametros.hasta.toISOString()).toBe("2026-04-01T02:59:59.000Z");
    // Sin `dias`: lo resuelve la ventana a partir del rango.
    expect(parametros.dias).toBeUndefined();
  });

  test.each(["desde", "hasta"])("exige el otro extremo si falta %s", (falta) => {
    const query = {
      desde: "2026-03-01T00:00:00.000-03:00",
      hasta: "2026-03-31T23:59:59.000-03:00",
    };
    delete query[falta];

    expect(mensajeDe(() => validarParametrosKpis(query))).toEqual({
      status: 400,
      mensaje: `Falta el parámetro "${falta}": el período necesita un rango de fechas`,
    });
  });

  test("rechaza fechas invertidas con el mensaje del resto de la API", () => {
    expect(
      mensajeDe(() =>
        validarParametrosKpis({
          desde: "2026-03-31T00:00:00.000-03:00",
          hasta: "2026-03-01T00:00:00.000-03:00",
        }),
      ),
    ).toEqual({
      status: 400,
      mensaje: 'La fecha "desde" no puede ser posterior a la fecha "hasta"',
    });
  });

  test("desde igual a hasta es un rango valido, no invertido", () => {
    const instante = "2026-03-01T10:00:00.000-03:00";

    expect(() =>
      validarParametrosKpis({ desde: instante, hasta: instante }),
    ).not.toThrow();
  });

  test("no se puede combinar con `dias`", () => {
    expect(
      mensajeDe(() =>
        validarParametrosKpis({
          dias: "7",
          desde: "2026-03-01T00:00:00.000-03:00",
          hasta: "2026-03-31T00:00:00.000-03:00",
        }),
      ),
    ).toEqual({
      status: 400,
      mensaje:
        'Los parámetros "dias" y "desde"/"hasta" no se pueden combinar: el período se pide de una forma o de la otra',
    });
  });

  test("exige zona horaria explicita, como el resto de la API", () => {
    // Sin `Z` ni offset: "el 1 de marzo" depende de donde este el usuario.
    expect(
      mensajeDe(() =>
        validarParametrosKpis({
          desde: "2026-03-01T00:00:00",
          hasta: "2026-03-31T00:00:00.000-03:00",
        }),
      ),
    ).toEqual({
      status: 400,
      mensaje:
        'El parámetro "desde" debe ser una fecha y hora ISO 8601 con zona, por ejemplo 2026-09-18T03:00:00.000Z',
    });
  });

  test("un rango vacio no es un rango: cae al default", () => {
    expect(validarParametrosKpis({ desde: "", hasta: "" })).toEqual({
      dias: DIAS_POR_DEFECTO,
    });
  });

  test("no deja pasar un comercioId de la query string", () => {
    expect(
      validarParametrosKpis({
        desde: "2026-03-01T00:00:00.000-03:00",
        hasta: "2026-03-02T00:00:00.000-03:00",
        comercioId: "otro-comercio",
      }).comercioId,
    ).toBeUndefined();
  });
});

describe("ventanaDeKpis (HU-23)", () => {
  const ahora = new Date("2026-11-22T13:00:00.000Z");

  test("sin rango da la misma ventana movil que HU-22", () => {
    const movil = ventanaDeDias(3, ahora);
    const ventana = ventanaDeKpis({ dias: 3 }, ahora);

    expect(ventana.fechas).toEqual(movil.fechas);
    expect(ventana.desde).toEqual(movil.desde);
    expect(ventana.hasta).toEqual(movil.hasta);
    expect(ventana.dias).toBe(3);
  });

  test("sin parametros usa el default", () => {
    expect(ventanaDeKpis({}, ahora).dias).toBe(DIAS_POR_DEFECTO);
  });

  test("con `desde` y sin `hasta` da 400 y no un TypeError", () => {
    // Es superficie compartida con HU-24: el 500 por `diaEnZona(undefined)`
    // seria un error del que nadie entiende nada.
    expect(
      mensajeDe(() =>
        ventanaDeKpis({ desde: new Date("2026-03-01T00:00:00.000-03:00") }, ahora),
      ),
    ).toEqual({
      status: 400,
      mensaje: 'Falta el parámetro "hasta": el período necesita un rango de fechas',
    });
  });

  test("un rango dentro de un mismo dia es un dia, no cero", () => {
    const ventana = ventanaDeKpis(
      {
        desde: new Date("2026-03-01T09:00:00.000-03:00"),
        hasta: new Date("2026-03-01T18:00:00.000-03:00"),
      },
      ahora,
    );

    expect(ventana.dias).toBe(1);
    expect(ventana.fechas).toEqual(["2026-03-01"]);
  });

  test("cuenta los dias calendario locales, con los dos extremos adentro", () => {
    const ventana = ventanaDeKpis(
      {
        desde: new Date("2026-03-01T00:00:00.000-03:00"),
        hasta: new Date("2026-03-31T23:59:59.000-03:00"),
      },
      ahora,
    );

    expect(ventana.dias).toBe(31);
    expect(ventana.fechas[0]).toBe("2026-03-01");
    expect(ventana.fechas.at(-1)).toBe("2026-03-31");
    expect(new Set(ventana.fechas).size).toBe(31);
  });

  test("el dia se corta en Argentina, no en UTC", () => {
    // Las 23:30 del 01/03 en Argentina son las 02:30 del 02/03 en UTC: si los
    // dias se cortaran en UTC, esta ventana tendria dos fechas.
    const ventana = ventanaDeKpis(
      {
        desde: new Date("2026-03-01T22:00:00.000-03:00"),
        hasta: new Date("2026-03-01T23:30:00.000-03:00"),
      },
      ahora,
    );

    expect(ventana.fechas).toEqual(["2026-03-01"]);
  });

  test("las 00:00 locales son el primer dia del rango, no el anterior", () => {
    const ventana = ventanaDeKpis(
      {
        desde: new Date("2026-03-02T00:00:00.000-03:00"),
        hasta: new Date("2026-03-02T00:00:00.000-03:00"),
      },
      ahora,
    );

    expect(ventana.fechas).toEqual(["2026-03-02"]);
  });

  test("conserva los instantes del cliente tal cual los mando", () => {
    const desde = new Date("2026-03-01T00:00:00.000-03:00");
    const hasta = new Date("2026-03-31T23:59:59.000-03:00");
    const ventana = ventanaDeKpis({ desde, hasta }, ahora);

    // No se redondean a medianoche: el recorte del SQL es exactamente lo pedido.
    expect(ventana.desde).toBe(desde);
    expect(ventana.hasta).toBe(hasta);
    expect(ventana.zonaHoraria).toBe("America/Argentina/Buenos_Aires");
  });

  test(`rechaza un rango de mas de ${DIAS_MAXIMOS_RANGO} dias`, () => {
    const desde = new Date("2024-01-01T00:00:00.000-03:00");
    const hasta = new Date("2026-01-01T00:00:00.000-03:00");

    expect(mensajeDe(() => ventanaDeKpis({ desde, hasta }, ahora))).toEqual({
      status: 400,
      mensaje: `El período no puede abarcar más de ${DIAS_MAXIMOS_RANGO} días y el pedido abarca 732`,
    });
  });

  test(`${DIAS_MAXIMOS_RANGO} dias justos entran`, () => {
    const desde = new Date("2026-01-01T00:00:00.000-03:00");
    const hasta = new Date(desde.getTime() + (DIAS_MAXIMOS_RANGO - 1) * 86400000);
    const ventana = ventanaDeKpis({ desde, hasta }, ahora);

    expect(ventana.dias).toBe(DIAS_MAXIMOS_RANGO);
    expect(ventana.fechas).toHaveLength(DIAS_MAXIMOS_RANGO);
  });

  describe("clave de cache", () => {
    test("dos rangos distintos no comparten clave", () => {
      const marzo = ventanaDeKpis(
        {
          desde: new Date("2026-03-01T00:00:00.000-03:00"),
          hasta: new Date("2026-03-31T23:59:59.000-03:00"),
        },
        ahora,
      );
      const abril = ventanaDeKpis(
        {
          desde: new Date("2026-04-01T00:00:00.000-03:00"),
          hasta: new Date("2026-04-30T23:59:59.000-03:00"),
        },
        ahora,
      );

      expect(marzo.clave).not.toBe(abril.clave);
    });

    test("la ventana movil no mete el instante del pedido en la clave", () => {
      // Si `hasta` (que es "ahora") entrara en la clave, la cache de HU-22 no
      // acertaria nunca: cada request tendria una clave nueva.
      const unaHoraDespues = new Date(ahora.getTime() + 60 * 60 * 1000);

      expect(ventanaDeKpis({ dias: 30 }, ahora).clave).toBe(
        ventanaDeKpis({ dias: 30 }, unaHoraDespues).clave,
      );
    });

    test("la ventana movil cambia de clave al cambiar el dia local", () => {
      const hoy = ventanaDeKpis({ dias: 30 }, ahora);
      const manana = ventanaDeKpis(
        { dias: 30 },
        new Date("2026-11-23T13:00:00.000Z"),
      );

      expect(hoy.clave).not.toBe(manana.clave);
    });

    test("y tampoco se confunde con un rango absoluto", () => {
      const movil = ventanaDeKpis({ dias: 30 }, ahora);
      const absoluto = ventanaDeKpis(
        {
          desde: new Date("2026-03-01T00:00:00.000-03:00"),
          hasta: new Date("2026-03-30T23:59:59.000-03:00"),
        },
        ahora,
      );

      expect(movil.dias).toBe(absoluto.dias);
      expect(movil.clave).not.toBe(absoluto.clave);
    });
  });
});

describe("ventanaDeDias", () => {
  test("cuenta dias calendario de Argentina, hoy incluido", () => {
    // 22/11 a las 10:00 en Argentina.
    const ahora = new Date("2026-11-22T13:00:00.000Z");
    const ventana = ventanaDeDias(3, ahora);

    expect(ventana.fechas).toEqual(["2026-11-20", "2026-11-21", "2026-11-22"]);
    // Medianoche del 20 en Argentina son las 03:00 UTC.
    expect(ventana.desde.toISOString()).toBe("2026-11-20T03:00:00.000Z");
    expect(ventana.hasta).toBe(ahora);
    expect(ventana.hoy).toBe("2026-11-22");
  });

  test("a las 23 h de Argentina el dia todavia no cambio, aunque en UTC si", () => {
    // 22/11 a las 23:30 en Argentina = 23/11 02:30 UTC.
    const ahora = new Date("2026-11-23T02:30:00.000Z");
    const ventana = ventanaDeDias(1, ahora);

    expect(ventana.fechas).toEqual(["2026-11-22"]);
    expect(ventana.desde.toISOString()).toBe("2026-11-22T03:00:00.000Z");
  });

  test("tiene exactamente `dias` fechas, tambien cruzando de mes", () => {
    const ventana = ventanaDeDias(30, new Date("2026-03-05T15:00:00.000Z"));

    expect(ventana.fechas).toHaveLength(30);
    expect(ventana.fechas[0]).toBe("2026-02-04");
    expect(ventana.fechas.at(-1)).toBe("2026-03-05");
    expect(new Set(ventana.fechas).size).toBe(30);
  });

  test("diaEnZona usa la hora de Argentina", () => {
    expect(diaEnZona(new Date("2026-11-23T02:59:00.000Z"))).toBe("2026-11-22");
    expect(diaEnZona(new Date("2026-11-23T03:00:00.000Z"))).toBe("2026-11-23");
  });
});

describe("completarSerie", () => {
  test("pone 0 en los dias sin ventas y respeta el orden de la ventana", () => {
    const serie = completarSerie(
      ["2026-11-20", "2026-11-21", "2026-11-22"],
      [{ fecha: "2026-11-22", ventas: 2, unidades: 5 }],
    );

    expect(serie).toEqual([
      { fecha: "2026-11-20", ventas: 0, unidades: 0 },
      { fecha: "2026-11-21", ventas: 0, unidades: 0 },
      { fecha: "2026-11-22", ventas: 2, unidades: 5 },
    ]);
  });

  test("ignora filas fuera de la ventana", () => {
    const serie = completarSerie(
      ["2026-11-22"],
      [{ fecha: "2026-10-01", ventas: 9, unidades: 9 }],
    );

    expect(serie).toEqual([{ fecha: "2026-11-22", ventas: 0, unidades: 0 }]);
  });
});

describe("diasDeCobertura", () => {
  test("stock dividido el ritmo diario de venta, redondeado para abajo", () => {
    // 10 unidades en 30 dias = 1/3 por dia; 56 / (1/3) = 168.
    expect(diasDeCobertura(56, 10, 30)).toBe(168);
    // 7 / (2 por dia) = 3,5 -> 3: prometer un dia que no hay es peor.
    expect(diasDeCobertura(7, 14, 7)).toBe(3);
  });

  test("sin stock la cobertura es 0", () => {
    expect(diasDeCobertura(0, 4, 30)).toBe(0);
  });

  test("sin ventas no hay ritmo y devuelve null", () => {
    expect(diasDeCobertura(20, 0, 30)).toBeNull();
  });
});

describe("resumirCompras", () => {
  const grupo = (id, unidades, compras = 1) => ({
    id,
    nombre: id ? `Proveedor ${id}` : null,
    activo: id ? true : null,
    compras,
    unidades,
    ultimaCompra: new Date("2026-11-20T12:00:00.000Z"),
  });

  test("los totales incluyen lo que no entra en la lista y lo sin proveedor", () => {
    const resumen = resumirCompras(
      [grupo("a", 30, 2), grupo("b", 10), grupo(null, 3), grupo("c", 5)],
      2,
    );

    expect(resumen.compras).toBe(5);
    expect(resumen.unidades).toBe(48);
    expect(resumen.proveedoresConCompras).toBe(3);
    expect(resumen.proveedores.map((p) => p.proveedor.id)).toEqual(["a", "b"]);
    expect(resumen.otros).toEqual({ proveedores: 1, compras: 1, unidades: 5 });
    expect(resumen.sinProveedor).toEqual({ compras: 1, unidades: 3 });
    expect(resumen.montos).toBeNull();
  });

  test("sin compras todo es cero y no hay otros ni sin proveedor", () => {
    expect(resumirCompras([])).toEqual({
      compras: 0,
      unidades: 0,
      proveedoresConCompras: 0,
      proveedores: [],
      otros: null,
      sinProveedor: null,
      montos: null,
    });
  });
});
