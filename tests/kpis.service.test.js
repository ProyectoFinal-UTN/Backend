import { describe, expect, test } from "@jest/globals";
import {
  DIAS_MAXIMOS,
  DIAS_POR_DEFECTO,
  completarSerie,
  diaEnZona,
  diasDeCobertura,
  resumirCompras,
  validarParametrosKpis,
  ventanaDeDias,
} from "../src/services/kpis.service.js";

/**
 * Tests unitarios de la logica pura de los KPIs (HU-22). Sin base: lo que pasa
 * contra Postgres esta en tests/kpis.test.js.
 */

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
