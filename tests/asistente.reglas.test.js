import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * Unitarios del modo degradado del asistente (HU-28).
 *
 * Se mockean las consultas SQL para no tocar la base: lo que se prueba acá es
 * qué intención se reconoce en cada pregunta y cómo se arma la respuesta. Las
 * consultas tienen sus propios datos reales en los E2E de Infraestructura, que
 * corren el stack sin LLM y por lo tanto siempre pasan por estas reglas.
 */

const productosParaReponer = jest.fn();
const stockDeProducto = jest.fn();
const movimientosRecientes = jest.fn();
const resumenDeActividad = jest.fn();

jest.unstable_mockModule("../src/services/asistente.consultas.service.js", () => ({
  productosParaReponer,
  stockDeProducto,
  movimientosRecientes,
  resumenDeActividad,
}));

const {
  MENSAJE_AYUDA,
  MENSAJE_GENERICO,
  MENSAJE_SIN_DATOS,
  detectarIntencion,
  normalizar,
  responderPorReglas,
} = await import("../src/services/asistente.reglas.service.js");

const COMERCIO_ID = "123e4567-e89b-12d3-a456-426614174000";

beforeEach(() => {
  jest.clearAllMocks();
  productosParaReponer.mockResolvedValue([]);
  stockDeProducto.mockResolvedValue([]);
  movimientosRecientes.mockResolvedValue({ movimientos: [] });
  resumenDeActividad.mockResolvedValue({ porTipo: [] });
});

describe("normalizar", () => {
  test("saca tildes, signos y mayúsculas", () => {
    expect(normalizar("¿Qué REPONGO?")).toBe("que repongo");
    expect(normalizar("  ¿Cuánta   yerba?! ")).toBe("cuanta yerba");
  });

  test("no rompe con algo que no es texto", () => {
    expect(normalizar(undefined)).toBe("");
    expect(normalizar(42)).toBe("42");
  });
});

describe("detectarIntencion — tabla de preguntas reales", () => {
  // Cada fila es una pregunta como la escribiría un comerciante. Si alguien
  // toca una regla y una de estas cambia de intención, el test lo dice.
  test.each([
    ["¿Qué productos tengo que reponer?", { intencion: "reponer" }],
    ["¿qué me falta?", { intencion: "reponer" }],
    ["¿Qué tengo que comprar?", { intencion: "reponer" }],
    ["¿Qué está por debajo del mínimo?", { intencion: "reponer" }],
    ["¿se me acabó algo?", { intencion: "reponer" }],

    ["¿Cómo viene el día?", { intencion: "resumen", dias: 1 }],
    ["Resumen de la semana", { intencion: "resumen", dias: 7 }],
    ["¿Qué se movió esta semana?", { intencion: "resumen", dias: 7 }],
    ["¿Cómo fue el mes?", { intencion: "resumen", dias: 30 }],

    ["¿Qué vendí hoy?", { intencion: "movimientos", dias: 1, tipo: "venta" }],
    ["¿Cuánto vendí?", { intencion: "movimientos", dias: 7, tipo: "venta" }],
    ["¿Hubo mermas?", { intencion: "movimientos", dias: 7, tipo: "merma" }],
    ["¿Qué compré ayer?", { intencion: "movimientos", dias: 2, tipo: "compra" }],
    ["ajustes de los últimos 15 días", { intencion: "movimientos", dias: 15, tipo: "ajuste" }],
    ["últimos movimientos", { intencion: "movimientos", dias: 7, tipo: undefined }],

    ["¿Cuánto me cobra mi proveedor?", { intencion: "sinDatos" }],
    ["¿A qué precio vendo la yerba?", { intencion: "sinDatos" }],

    ["¿Cuánta yerba me queda?", { intencion: "stock", busqueda: "yerba" }],
    ["¿Tengo coca?", { intencion: "stock", busqueda: "coca" }],
    ["¿Dónde está la harina?", { intencion: "stock", busqueda: "harina" }],
    ["¿cuántos alfajores hay?", { intencion: "stock", busqueda: "alfajores" }],
    ["¿cuánto me queda?", { intencion: "stock", busqueda: "" }],

    ["hola", { intencion: "ayuda" }],
    ["¿quién ganó el partido?", { intencion: "ayuda" }],
  ])("«%s»", (pregunta, esperado) => {
    expect(detectarIntencion(pregunta)).toEqual(esperado);
  });

  test("la ventana de días tiene techo de 90", () => {
    expect(detectarIntencion("ventas de los últimos 99 días").dias).toBe(90);
  });
});

describe("responderPorReglas — reponer", () => {
  test("sin nada para reponer, lo dice", async () => {
    expect(await responderPorReglas(COMERCIO_ID, "¿qué repongo?")).toBe(
      "No tenés productos por debajo del stock mínimo.",
    );
  });

  test("lista los productos con lo que queda y su mínimo", async () => {
    productosParaReponer.mockResolvedValue([
      { nombre: "Alfajor Jorgito", enStock: 0, umbralMinimo: 5, unidadMedida: "unidad" },
      { nombre: "Harina 000", enStock: 2, umbralMinimo: 10, unidadMedida: "kg" },
    ]);

    const respuesta = await responderPorReglas(COMERCIO_ID, "¿qué repongo?");

    expect(respuesta).toBe(
      "Tenés 2 productos para reponer:\n" +
        "• Alfajor Jorgito: quedan 0 unidades, el mínimo es 5\n" +
        "• Harina 000: quedan 2 kg, el mínimo es 10",
    );
    expect(productosParaReponer).toHaveBeenCalledWith(COMERCIO_ID, { limite: 50 });
  });

  test("corta la lista larga y dice cuántos faltan", async () => {
    productosParaReponer.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({
        nombre: `Producto ${i + 1}`,
        enStock: 1,
        umbralMinimo: 3,
        unidadMedida: "unidad",
      })),
    );

    const respuesta = await responderPorReglas(COMERCIO_ID, "¿qué repongo?");

    expect(respuesta).toContain("Tenés 8 productos para reponer:");
    expect(respuesta).toContain("• Producto 5:");
    expect(respuesta).not.toContain("Producto 6");
    expect(respuesta).toContain("…y 3 más. Los ves todos en Productos.");
  });
});

describe("responderPorReglas — stock", () => {
  test("un producto, con su saldo y el detalle por ubicación", async () => {
    stockDeProducto.mockResolvedValue([
      {
        nombre: "Yerba Playadito 1kg",
        enStock: 7,
        unidadMedida: "unidad",
        umbralMinimo: 3,
        porDebajoDelUmbral: false,
        porUbicacion: [
          { ubicacion: "Depósito", cantidad: 5 },
          { ubicacion: "Local", cantidad: 2 },
        ],
      },
    ]);

    expect(await responderPorReglas(COMERCIO_ID, "¿cuánta yerba me queda?")).toBe(
      "De Yerba Playadito 1kg te quedan 7 unidades (Depósito: 5, Local: 2).",
    );
    expect(stockDeProducto).toHaveBeenCalledWith(COMERCIO_ID, { busqueda: "yerba" });
  });

  test("avisa si está en el mínimo o por debajo", async () => {
    stockDeProducto.mockResolvedValue([
      {
        nombre: "Alfajor Jorgito",
        enStock: 1,
        unidadMedida: "unidad",
        umbralMinimo: 5,
        porDebajoDelUmbral: true,
        porUbicacion: [{ ubicacion: "Principal", cantidad: 1 }],
      },
    ]);

    expect(await responderPorReglas(COMERCIO_ID, "¿tengo alfajor?")).toBe(
      // "te queda 1 unidad", en singular.
      "De Alfajor Jorgito te queda 1 unidad. Está en el mínimo o por debajo (el mínimo es 5).",
    );
  });

  test("si el plural no encuentra nada, prueba en singular", async () => {
    // "cocas" no matchea "Coca-Cola"; "coca" sí.
    stockDeProducto
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          nombre: "Coca-Cola 500ml",
          enStock: 12,
          unidadMedida: "unidad",
          umbralMinimo: 6,
          porDebajoDelUmbral: false,
          porUbicacion: [{ ubicacion: "Principal", cantidad: 12 }],
        },
      ]);

    const respuesta = await responderPorReglas(COMERCIO_ID, "¿cuántas cocas me quedan?");

    expect(stockDeProducto).toHaveBeenNthCalledWith(1, COMERCIO_ID, { busqueda: "cocas" });
    expect(stockDeProducto).toHaveBeenNthCalledWith(2, COMERCIO_ID, { busqueda: "coca" });
    expect(respuesta).toBe("De Coca-Cola 500ml te quedan 12 unidades.");
  });

  test("varios productos: los lista", async () => {
    stockDeProducto.mockResolvedValue([
      { nombre: "Coca-Cola 500ml", enStock: 12, unidadMedida: "unidad", porUbicacion: [] },
      { nombre: "Coca-Cola 1.5l", enStock: 4, unidadMedida: "unidad", porUbicacion: [] },
    ]);

    expect(await responderPorReglas(COMERCIO_ID, "¿tengo coca?")).toBe(
      "Encontré 2 productos:\n• Coca-Cola 500ml: 12 unidades\n• Coca-Cola 1.5l: 4 unidades",
    );
  });

  test("si no encuentra nada, lo dice con lo que se buscó", async () => {
    expect(await responderPorReglas(COMERCIO_ID, "¿tengo fernet?")).toBe(
      "No encontré ningún producto que se llame «fernet».",
    );
  });

  test("sin nombre de producto, lo pide en vez de buscar todo", async () => {
    const respuesta = await responderPorReglas(COMERCIO_ID, "¿cuánto me queda?");

    expect(respuesta).toMatch(/^¿De qué producto\?/);
    expect(stockDeProducto).not.toHaveBeenCalled();
  });
});

describe("responderPorReglas — movimientos y resumen", () => {
  test("lista los movimientos del tipo pedido, con la cantidad sin signo", async () => {
    // En el libro la salida se guarda negativa; contarle a alguien que vendió
    // "-3 unidades" no tiene sentido.
    movimientosRecientes.mockResolvedValue({
      movimientos: [
        {
          fecha: "2026-10-06T15:00:00.000Z",
          tipo: "venta",
          cantidad: -3,
          unidadMedida: "unidad",
          producto: "Coca-Cola 500ml",
        },
      ],
    });

    const respuesta = await responderPorReglas(COMERCIO_ID, "¿qué vendí hoy?");

    expect(movimientosRecientes).toHaveBeenCalledWith(COMERCIO_ID, {
      dias: 1,
      tipo: "venta",
      limite: 50,
    });
    expect(respuesta).toBe(
      "Últimas ventas (las últimas 24 horas):\n• 06/10: venta de 3 unidades de Coca-Cola 500ml",
    );
  });

  test("el título concuerda con el tipo: últimos ajustes, últimos movimientos", async () => {
    const ajuste = {
      fecha: "2026-10-06T15:00:00.000Z",
      tipo: "ajuste",
      cantidad: 2,
      unidadMedida: "kg",
      producto: "Harina 000",
    };
    movimientosRecientes.mockResolvedValue({ movimientos: [ajuste] });

    expect(await responderPorReglas(COMERCIO_ID, "¿hubo ajustes?")).toMatch(/^Últimos ajustes/);
    expect(await responderPorReglas(COMERCIO_ID, "últimos movimientos")).toMatch(
      /^Últimos movimientos/,
    );
  });

  test("la fecha sale en horario de Argentina, no en UTC", async () => {
    // 01:00 UTC del 7 de octubre son las 22:00 del 6 en Argentina.
    movimientosRecientes.mockResolvedValue({
      movimientos: [
        {
          fecha: "2026-10-07T01:00:00.000Z",
          tipo: "venta",
          cantidad: -1,
          unidadMedida: "unidad",
          producto: "Coca-Cola 500ml",
        },
      ],
    });

    expect(await responderPorReglas(COMERCIO_ID, "¿qué vendí?")).toContain("• 06/10:");
  });

  test("sin movimientos, lo dice con el período", async () => {
    expect(await responderPorReglas(COMERCIO_ID, "¿hubo mermas?")).toBe(
      "No hubo mermas en los últimos 7 días.",
    );
  });

  test("el resumen cuenta los movimientos por tipo", async () => {
    resumenDeActividad.mockResolvedValue({
      porTipo: [
        { tipo: "compra", movimientos: 1, unidades: 24 },
        { tipo: "venta", movimientos: 5, unidades: -11 },
      ],
    });

    expect(await responderPorReglas(COMERCIO_ID, "¿cómo viene el día?")).toBe(
      "En las últimas 24 horas hubo 6 movimientos:\n• 1 compra\n• 5 ventas",
    );
  });

  test("resumen sin actividad", async () => {
    expect(await responderPorReglas(COMERCIO_ID, "resumen de la semana")).toBe(
      "No hubo movimientos en los últimos 7 días.",
    );
  });
});

describe("responderPorReglas — lo que no sabe", () => {
  test("proveedores y precios: dice que todavía no los tiene", async () => {
    expect(await responderPorReglas(COMERCIO_ID, "¿cuánto me cobra el proveedor?")).toBe(
      MENSAJE_SIN_DATOS,
    );
    expect(stockDeProducto).not.toHaveBeenCalled();
  });

  test("algo que no reconoce: explica qué se puede preguntar", async () => {
    expect(await responderPorReglas(COMERCIO_ID, "hola")).toBe(MENSAJE_AYUDA);
  });
});

describe("responderPorReglas — nunca tira", () => {
  test("si la consulta falla, devuelve el texto genérico", async () => {
    // Es el plan B: si también tirara, la persona se quedaría sin respuesta.
    productosParaReponer.mockRejectedValue(new Error("connection terminated"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(responderPorReglas(COMERCIO_ID, "¿qué repongo?")).resolves.toBe(
      MENSAJE_GENERICO,
    );
  });
});
