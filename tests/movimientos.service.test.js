import { describe, expect, test } from "@jest/globals";
import {
  validarDatosMovimiento,
  validarFiltrosHistorial,
} from "../src/services/movimientos.service.js";

/**
 * Unitario puro de la validacion de HU-13 — no toca la base, igual que
 * `tests/productos.service.test.js` con `validarDatosProducto`. El resto de la
 * logica (la transaccion, el stock insuficiente, la resolucion de ubicacion)
 * se cubre en `tests/movimientos.test.js`, que si necesita datos reales.
 */

const PRODUCTO_ID = "123e4567-e89b-12d3-a456-426614174000";
const UBICACION_ID = "223e4567-e89b-12d3-a456-426614174001";
const PROVEEDOR_ID = "323e4567-e89b-12d3-a456-426614174002";

function movimiento(overrides = {}) {
  return { productoId: PRODUCTO_ID, tipo: "venta", cantidad: 3, ...overrides };
}

describe("validarDatosMovimiento — signo según el tipo", () => {
  test("una compra suma: la cantidad queda positiva", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "compra" })).cantidad).toBe(
      3,
    );
  });

  test("una venta resta: la cantidad queda negativa", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "venta" })).cantidad).toBe(
      -3,
    );
  });

  test("una merma resta", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "merma", motivo: "Rotura" }))
        .cantidad,
    ).toBe(-3);
  });

  test("normaliza el tipo con espacios y mayúsculas", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "  COMPRA " })).tipo).toBe(
      "compra",
    );
  });
});

describe("validarDatosMovimiento — ajuste", () => {
  test("con sentido entrada suma", () => {
    expect(
      validarDatosMovimiento(
        movimiento({ tipo: "ajuste", sentido: "entrada", motivo: "Recuento" }),
      ).cantidad,
    ).toBe(3);
  });

  test("con sentido salida resta", () => {
    expect(
      validarDatosMovimiento(
        movimiento({ tipo: "ajuste", sentido: "salida", motivo: "Recuento" }),
      ).cantidad,
    ).toBe(-3);
  });

  test("sin sentido lo rechaza: el signo sería ambiguo", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "ajuste" })),
    ).toThrow(/sentido/i);
  });

  test("con un sentido inválido lo rechaza", () => {
    expect(() =>
      validarDatosMovimiento(
        movimiento({ tipo: "ajuste", sentido: "cualquiera" }),
      ),
    ).toThrow(/sentido/i);
  });

  test("el sentido se ignora en los tipos que no son ajuste", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "venta", sentido: "entrada" }))
        .cantidad,
    ).toBe(-3);
  });
});

describe("validarDatosMovimiento — motivo (HU-15)", () => {
  test("un ajuste sin motivo se rechaza", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "ajuste", sentido: "salida" })),
    ).toThrow(/motivo/i);
  });

  test("una merma sin motivo se rechaza", () => {
    expect(() => validarDatosMovimiento(movimiento({ tipo: "merma" }))).toThrow(
      /motivo/i,
    );
  });

  test("un motivo en blanco no cuenta como motivo", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "merma", motivo: "    " })),
    ).toThrow(/motivo/i);
  });

  test("un motivo que no es texto se rechaza", () => {
    // Sin el typeof, un 42 mal serializado entraria como motivo "42" en un
    // libro que despues no se puede editar.
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "merma", motivo: 42 })),
    ).toThrow(/motivo/i);
  });

  test("recorta los espacios del motivo", () => {
    expect(
      validarDatosMovimiento(
        movimiento({ tipo: "merma", motivo: "  Producto vencido  " }),
      ).motivo,
    ).toBe("Producto vencido");
  });

  test("una compra no necesita motivo y queda en null", () => {
    expect(validarDatosMovimiento(movimiento({ tipo: "compra" })).motivo).toBe(
      null,
    );
  });

  test("una venta puede llevar motivo igual, y se guarda", () => {
    expect(
      validarDatosMovimiento(
        movimiento({ tipo: "venta", motivo: "Venta mostrador" }),
      ).motivo,
    ).toBe("Venta mostrador");
  });

  test("un motivo vacío en una compra queda en null, no en cadena vacía", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "compra", motivo: "   " }))
        .motivo,
    ).toBe(null);
  });

  test("acepta un motivo de exactamente 255 caracteres", () => {
    const motivo = "a".repeat(255);
    expect(
      validarDatosMovimiento(movimiento({ tipo: "merma", motivo })).motivo,
    ).toBe(motivo);
  });

  test("rechaza un motivo que no entra en la columna", () => {
    expect(() =>
      validarDatosMovimiento(
        movimiento({ tipo: "merma", motivo: "a".repeat(256) }),
      ),
    ).toThrow(/255/);
  });
});

describe("validarDatosMovimiento — tipo", () => {
  test("rechaza un tipo que no existe", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "devolucion" })),
    ).toThrow(/tipo de movimiento/i);
  });

  test("rechaza 'transferencia': esos movimientos los crea HU-12 en pares ligados", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ tipo: "transferencia" })),
    ).toThrow(/tipo de movimiento/i);
  });

  test("rechaza cuando falta el tipo", () => {
    expect(() => validarDatosMovimiento({ productoId: PRODUCTO_ID, cantidad: 3 })).toThrow(
      /tipo de movimiento/i,
    );
  });
});

describe("validarDatosMovimiento — cantidad", () => {
  test.each([
    ["cero", 0],
    ["negativa", -5],
    ["decimal", 1.5],
    ["texto", "muchas"],
    ["ausente", undefined],
    ["nula", null],
    // Los tres siguientes son los que `Number(...)` colaria: `Number(true)` da
    // 1, `Number([3])` da 3 y `Number("4")` da 4. Un campo mal serializado no
    // puede entrar como movimiento real en un libro que no se puede editar.
    ["booleana", true],
    ["un array", [3]],
    ["numérica pero en string", "4"],
  ])("rechaza una cantidad %s", (_caso, cantidad) => {
    expect(() => validarDatosMovimiento(movimiento({ cantidad }))).toThrow(
      /cantidad/i,
    );
  });

  test("acepta el máximo que entra en un integer de Postgres", () => {
    expect(
      validarDatosMovimiento(movimiento({ tipo: "compra", cantidad: 2147483647 }))
        .cantidad,
    ).toBe(2147483647);
  });

  test("rechaza una cantidad que desbordaría la columna integer", () => {
    // Sin este tope el INSERT falla con 22003 y sale como 500, no como 400.
    expect(() =>
      validarDatosMovimiento(movimiento({ cantidad: 3000000000 })),
    ).toThrow(/cantidad/i);
  });
});

describe("validarDatosMovimiento — producto, ubicación y proveedor", () => {
  test("rechaza un productoId que no es UUID", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ productoId: "no-es-uuid" })),
    ).toThrow(/producto/i);
  });

  test("rechaza cuando falta el productoId", () => {
    expect(() => validarDatosMovimiento({ tipo: "venta", cantidad: 3 })).toThrow(
      /producto/i,
    );
  });

  test("la ubicación es opcional y queda undefined si no viene", () => {
    expect(validarDatosMovimiento(movimiento()).ubicacionId).toBeUndefined();
  });

  test("acepta una ubicación con formato válido", () => {
    expect(
      validarDatosMovimiento(movimiento({ ubicacionId: UBICACION_ID }))
        .ubicacionId,
    ).toBe(UBICACION_ID);
  });

  test("rechaza una ubicación que no es UUID", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ ubicacionId: "no-es-uuid" })),
    ).toThrow(/ubicación/i);
  });

  test("el proveedor es opcional y queda en null si no viene", () => {
    expect(validarDatosMovimiento(movimiento()).proveedorId).toBeNull();
  });

  test("acepta un proveedor con formato válido", () => {
    expect(
      validarDatosMovimiento(movimiento({ proveedorId: PROVEEDOR_ID }))
        .proveedorId,
    ).toBe(PROVEEDOR_ID);
  });

  test("rechaza un proveedor que no es UUID", () => {
    expect(() =>
      validarDatosMovimiento(movimiento({ proveedorId: "no-es-uuid" })),
    ).toThrow(/proveedor/i);
  });
});

describe("validarDatosMovimiento — datos que no se aceptan del body", () => {
  test("ignora un comercioId mezclado en los datos", () => {
    expect(
      validarDatosMovimiento(movimiento({ comercioId: "otro-comercio" })),
    ).not.toHaveProperty("comercioId");
  });

  test("ignora un usuarioId mezclado en los datos", () => {
    expect(
      validarDatosMovimiento(movimiento({ usuarioId: "otro-usuario" })),
    ).not.toHaveProperty("usuarioId");
  });

  test("ignora un transferenciaId mezclado en los datos", () => {
    expect(
      validarDatosMovimiento(movimiento({ transferenciaId: PROVEEDOR_ID })),
    ).not.toHaveProperty("transferenciaId");
  });
});

/* ---------------------------------------------------------------------------
 * HU-14 — filtros del historial
 * ------------------------------------------------------------------------- */

describe("validarFiltrosHistorial — sin filtros", () => {
  test("sin parámetros devuelve la primera página con el límite por defecto", () => {
    expect(validarFiltrosHistorial({})).toEqual({
      desde: undefined,
      hasta: undefined,
      tipo: undefined,
      productoId: undefined,
      proveedorId: undefined,
      ubicacionId: undefined,
      pagina: 1,
      limite: 50,
    });
  });

  test("los parámetros vacíos cuentan como no enviados", () => {
    const filtros = validarFiltrosHistorial({
      desde: "",
      tipo: "",
      productoId: "",
      pagina: "",
    });

    expect(filtros.desde).toBeUndefined();
    expect(filtros.tipo).toBeUndefined();
    expect(filtros.productoId).toBeUndefined();
    expect(filtros.pagina).toBe(1);
  });

  test("ignora un comercioId mezclado en la query string", () => {
    expect(
      validarFiltrosHistorial({ comercioId: PRODUCTO_ID }),
    ).not.toHaveProperty("comercioId");
  });
});

describe("validarFiltrosHistorial — rango de fechas", () => {
  test("acepta instantes ISO con Z y con offset", () => {
    const filtros = validarFiltrosHistorial({
      desde: "2026-09-01T00:00:00-03:00",
      hasta: "2026-09-18T23:59:59.999Z",
    });

    expect(filtros.desde.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(filtros.hasta.toISOString()).toBe("2026-09-18T23:59:59.999Z");
  });

  test("acepta un rango de un solo instante (desde igual a hasta)", () => {
    const instante = "2026-09-18T12:00:00.000Z";

    expect(() =>
      validarFiltrosHistorial({ desde: instante, hasta: instante }),
    ).not.toThrow();
  });

  test("rechaza una fecha sin zona: el día sería ambiguo", () => {
    expect(() =>
      validarFiltrosHistorial({ desde: "2026-09-18T00:00:00" }),
    ).toThrow(/desde/);
  });

  test("rechaza una fecha sola, sin hora", () => {
    expect(() => validarFiltrosHistorial({ hasta: "2026-09-18" })).toThrow(
      /hasta/,
    );
  });

  test("rechaza un texto que no es una fecha", () => {
    expect(() => validarFiltrosHistorial({ desde: "ayer" })).toThrow(/desde/);
  });

  test("rechaza una fecha con el formato bien pero imposible", () => {
    expect(() =>
      validarFiltrosHistorial({ desde: "2026-13-45T00:00:00Z" }),
    ).toThrow(/desde/);
  });

  test("rechaza un parámetro repetido, que Express entrega como array", () => {
    expect(() =>
      validarFiltrosHistorial({
        desde: ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
      }),
    ).toThrow(/desde/);
  });

  test("rechaza desde posterior a hasta, con status 400", () => {
    let error;
    try {
      validarFiltrosHistorial({
        desde: "2026-09-18T00:00:00Z",
        hasta: "2026-09-01T00:00:00Z",
      });
    } catch (e) {
      error = e;
    }

    expect(error.message).toMatch(/posterior/);
    expect(error.status).toBe(400);
  });
});

describe("validarFiltrosHistorial — tipo", () => {
  test.each(["compra", "venta", "ajuste", "merma", "transferencia"])(
    "acepta %s",
    (tipo) => {
      expect(validarFiltrosHistorial({ tipo }).tipo).toBe(tipo);
    },
  );

  test("normaliza espacios y mayúsculas", () => {
    expect(validarFiltrosHistorial({ tipo: "  VENTA " }).tipo).toBe("venta");
  });

  test("rechaza un tipo desconocido", () => {
    expect(() => validarFiltrosHistorial({ tipo: "regalo" })).toThrow(
      /tipo de movimiento/i,
    );
  });
});

describe("validarFiltrosHistorial — ids", () => {
  test("acepta UUIDs de producto, proveedor y ubicación", () => {
    const filtros = validarFiltrosHistorial({
      productoId: PRODUCTO_ID,
      proveedorId: PROVEEDOR_ID,
      ubicacionId: UBICACION_ID,
    });

    expect(filtros.productoId).toBe(PRODUCTO_ID);
    expect(filtros.proveedorId).toBe(PROVEEDOR_ID);
    expect(filtros.ubicacionId).toBe(UBICACION_ID);
  });

  test.each(["productoId", "proveedorId", "ubicacionId"])(
    "rechaza un %s que no es UUID, antes de que llegue a la base",
    (campo) => {
      expect(() => validarFiltrosHistorial({ [campo]: "123" })).toThrow(
        new RegExp(campo),
      );
    },
  );
});

describe("validarFiltrosHistorial — paginación", () => {
  test("lee página y límite de la query string", () => {
    const filtros = validarFiltrosHistorial({ pagina: "3", limite: "20" });

    expect(filtros.pagina).toBe(3);
    expect(filtros.limite).toBe(20);
  });

  test("recorta el límite al máximo en vez de rechazarlo", () => {
    expect(validarFiltrosHistorial({ limite: "5000" }).limite).toBe(200);
  });

  test.each(["0", "-1", "1.5", "abc", "1e3"])(
    "rechaza la página %s",
    (pagina) => {
      expect(() => validarFiltrosHistorial({ pagina })).toThrow(/pagina/);
    },
  );
});
