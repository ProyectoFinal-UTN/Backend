import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * Unitarios de las recomendaciones proactivas (HU-27).
 *
 * Se mockea el borde del LLM (`src/lib/llm.js`) y las consultas SQL: lo que se
 * prueba acá es el criterio —quién entra como recomendación y quién no—, la
 * redacción por plantillas y la convivencia con el modo degradado de HU-28.
 *
 * El SQL de `rotacionDeProductos` tiene sus propios tests contra la base en
 * `tests/asistente.consultas.test.js`: el filtro de producto nuevo, el de stock
 * en cero y el signo de las ventas viven en la consulta y no acá, así que
 * mockearlos no probaría nada.
 *
 * Ningún test llama al proveedor real, que es regla del equipo: el crédito del
 * Gateway es uno solo para los tres integrantes.
 */

const consultarModelo = jest.fn();
const hayProveedorConfigurado = jest.fn();
const productosParaReponer = jest.fn(async () => []);
const rotacionDeProductos = jest.fn();

jest.unstable_mockModule("../src/lib/llm.js", () => ({
  consultarModelo,
  hayProveedorConfigurado,
  TIMEOUT_MS: 4000,
}));

jest.unstable_mockModule("../src/services/asistente.consultas.service.js", () => ({
  TIPOS_DE_MOVIMIENTO: ["compra", "venta", "merma", "ajuste", "transferencia"],
  productosParaReponer,
  rotacionDeProductos,
  // Las tres que no usa HU-27 van igual: `asistente.reglas.service.js` las
  // importa, y de ahí salen las plantillas de redacción que este módulo reusa.
  stockDeProducto: jest.fn(async () => []),
  movimientosRecientes: jest.fn(async () => ({ movimientos: [] })),
  resumenDeActividad: jest.fn(async () => ({ porTipo: [] })),
}));

const {
  RESUMEN_SIN_RECOMENDACIONES,
  TIPOS_DE_RECOMENDACION,
  analizar,
  diasDeAnalisis,
  limpiarCacheDeResumen,
  recomendar,
  resumenPorPlantilla,
  ventasMinimas,
} = await import("../src/services/asistente.recomendaciones.service.js");

const COMERCIO_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTRO_COMERCIO_ID = "223e4567-e89b-12d3-a456-426614174001";

/** El 06/09, para que el `porQue` tenga una fecha estable. */
const DESDE = new Date("2026-09-06T12:00:00.000Z");

const USO = {
  modelo: "google/gemini-2.5-flash",
  entrada: 320,
  salida: 48,
  costoUsd: 0.00022,
};

/** Lo que devuelve `rotacionDeProductos`, con ventas de sobra por defecto. */
function rotacion({ ventasDelComercio = 10, productos = [], dias = 30 } = {}) {
  return { desde: DESDE, dias, ventasDelComercio, productos };
}

/** Un producto con existencias, parado (sin ventas en la ventana). */
function quieto(overrides = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    nombre: "Yerba Playadito",
    categoria: "Almacén",
    unidadMedida: "unidad",
    enStock: 12,
    ventas: 0,
    unidadesVendidas: 0,
    ...overrides,
  };
}

/** Una fila como la devuelve `productosParaReponer`. */
function faltante(overrides = {}) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    nombre: "Harina 000",
    categoria: "Almacén",
    unidadMedida: "kg",
    umbralMinimo: 10,
    enStock: 0,
    faltanteHastaElUmbral: 10,
    ...overrides,
  };
}

const deTipo = (resultado, tipo) =>
  resultado.recomendaciones.filter((una) => una.tipo === tipo);

/** El espía de la línea de costo, para no nombrar `console.info` en el test. */
let avisosDeCosto;

beforeEach(() => {
  jest.clearAllMocks();
  limpiarCacheDeResumen();

  // Los parametros configurables se leen del ambiente en cada llamada: si
  // quedan de un caso anterior, o del .env de quien corre la suite, los
  // criterios dejan de ser los que el test cree estar probando.
  delete process.env.RECOMENDACIONES_DIAS;
  delete process.env.RECOMENDACIONES_VENTAS_MINIMAS;

  avisosDeCosto = jest.spyOn(console, "info").mockImplementation(() => {});

  productosParaReponer.mockResolvedValue([]);
  rotacionDeProductos.mockResolvedValue(rotacion());
  hayProveedorConfigurado.mockReturnValue(true);
  consultarModelo.mockResolvedValue({
    texto: "Tenés harina en cero y la yerba parada. Yo arrancaría por la harina.",
    herramientasUsadas: [],
    uso: USO,
  });
});

/* ------------------------------------------------------------------ */

describe("diasDeAnalisis", () => {
  test("sin nada configurado son 30 días", () => {
    expect(diasDeAnalisis(undefined)).toBe(30);
  });

  test("lo que pide el request gana sobre el .env", () => {
    process.env.RECOMENDACIONES_DIAS = "45";

    expect(diasDeAnalisis("7")).toBe(7);
  });

  test("el .env gana sobre el default cuando el request no pide nada", () => {
    process.env.RECOMENDACIONES_DIAS = "45";

    expect(diasDeAnalisis(undefined)).toBe(45);
  });

  test("recorta el exceso en vez de descartarlo", () => {
    // "dame todo lo que haya" es un pedido legítimo, y 90 es todo lo que hay.
    expect(diasDeAnalisis("5000")).toBe(90);
  });

  test("lo que no es un entero válido cae al default, no a un borde", () => {
    for (const valor of ["", "muchos", "7.5", "-3", "0", null]) {
      expect(diasDeAnalisis(valor)).toBe(30);
    }
  });
});

describe("ventasMinimas", () => {
  test("son 3 por defecto", () => {
    expect(ventasMinimas()).toBe(3);
  });

  test("se puede bajar o subir desde el .env", () => {
    process.env.RECOMENDACIONES_VENTAS_MINIMAS = "1";

    expect(ventasMinimas()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */

describe("analizar — reposición", () => {
  test("un producto sin existencias sale con prioridad alta", async () => {
    productosParaReponer.mockResolvedValue([faltante()]);

    const [recomendacion] = (
      await analizar(COMERCIO_ID)
    ).recomendaciones;

    expect(recomendacion.tipo).toBe(TIPOS_DE_RECOMENDACION.REPONER);
    expect(recomendacion.prioridad).toBe("alta");
    expect(recomendacion.producto).toEqual({
      id: faltante().id,
      nombre: "Harina 000",
    });
    expect(recomendacion.texto).toContain("No te queda nada de Harina 000");
    expect(recomendacion.texto).toContain("10 kg");
    expect(recomendacion.porQue).toContain("No quedan existencias");
    expect(recomendacion.datos).toMatchObject({
      enStock: 0,
      umbralMinimo: 10,
      unidadMedida: "kg",
    });
  });

  test("un producto justo en el umbral sale con prioridad media", async () => {
    productosParaReponer.mockResolvedValue([
      faltante({ enStock: 10, faltanteHastaElUmbral: 0 }),
    ]);

    const [recomendacion] = (await analizar(COMERCIO_ID)).recomendaciones;

    expect(recomendacion.prioridad).toBe("media");
    expect(recomendacion.texto).toContain("te quedan 10 kg");
  });

  test("el texto no supone el género del nombre del producto", async () => {
    // "reponerlo"/"reponerla" no se puede saber desde el nombre, y errarle se
    // lee peor que evitarlo.
    productosParaReponer.mockResolvedValue([faltante()]);

    const [recomendacion] = (await analizar(COMERCIO_ID)).recomendaciones;

    expect(recomendacion.texto).not.toMatch(/reponerl[oa]/);
  });
});

describe("analizar — baja rotación", () => {
  test("un producto con stock y sin ventas en la ventana sale como baja rotación", async () => {
    rotacionDeProductos.mockResolvedValue(
      rotacion({ productos: [quieto()] }),
    );

    const [recomendacion] = (await analizar(COMERCIO_ID)).recomendaciones;

    expect(recomendacion.tipo).toBe(TIPOS_DE_RECOMENDACION.BAJA_ROTACION);
    expect(recomendacion.producto.nombre).toBe("Yerba Playadito");
    expect(recomendacion.texto).toContain(
      "Hace 30 días que no vendés Yerba Playadito",
    );
    expect(recomendacion.texto).toContain("te quedan 12 unidades");
    // El `porQue` nombra la ventana con fechas, no con jerga.
    expect(recomendacion.porQue).toContain("06/09");
    expect(recomendacion.datos).toMatchObject({
      enStock: 12,
      ventasEnVentana: 0,
      diasSinVenta: 30,
    });
  });

  test("un producto que vendió no sale, aunque tenga mucho stock", async () => {
    rotacionDeProductos.mockResolvedValue(
      rotacion({
        productos: [quieto({ ventas: 1, unidadesVendidas: 5, enStock: 99 })],
      }),
    );

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toEqual([]);
  });

  test("el criterio mira la cantidad de ventas, no las unidades", async () => {
    // Las ventas se guardan con `cantidad` negativa. Si alguien calculara las
    // unidades sin dar vuelta el signo le daría -5, y un criterio apoyado en
    // las unidades pasaría a marcar como parado un producto que se vendió.
    rotacionDeProductos.mockResolvedValue(
      rotacion({ productos: [quieto({ ventas: 1, unidadesVendidas: -5 })] }),
    );

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toEqual([]);
  });

  test("se devuelven como máximo 5, aunque haya más parados", async () => {
    rotacionDeProductos.mockResolvedValue(
      rotacion({
        productos: Array.from({ length: 9 }, (_, i) =>
          quieto({ id: `p-${i}`, nombre: `Producto ${i}` }),
        ),
      }),
    );

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toHaveLength(
      5,
    );
  });

  test("le pasa a la consulta la ventana resuelta", async () => {
    await analizar(COMERCIO_ID, { dias: "15" });

    expect(rotacionDeProductos).toHaveBeenCalledWith(COMERCIO_ID, { dias: 15 });
  });
});

describe("analizar — un producto, una sola recomendación", () => {
  /** El mismo producto bajo el umbral Y sin ventas: los dos criterios aplican. */
  const ID = "33333333-3333-3333-3333-333333333333";

  beforeEach(() => {
    productosParaReponer.mockResolvedValue([
      faltante({ id: ID, nombre: "Yerba Parada", enStock: 5, umbralMinimo: 10 }),
    ]);
    rotacionDeProductos.mockResolvedValue(
      rotacion({
        productos: [quieto({ id: ID, nombre: "Yerba Parada", enStock: 5 })],
      }),
    );
  });

  test("no se recomienda dos veces el mismo producto", async () => {
    const { recomendaciones } = await analizar(COMERCIO_ID);

    const delProducto = recomendaciones.filter((una) => una.producto?.id === ID);

    expect(delProducto).toHaveLength(1);
  });

  test("no se dice a la vez «reponer» y «no reponer por ahora»", async () => {
    // Era el síntoma real: las dos recomendaciones salían una al lado de la
    // otra, con consejos opuestos para el mismo producto.
    const { recomendaciones } = await analizar(COMERCIO_ID);
    const textos = recomendaciones.map((una) => una.texto).join(" ");

    expect(textos).toContain("Es buen momento para reponer");
    expect(textos).not.toContain("no reponer por ahora");
  });

  test("gana la reposición, porque el umbral lo fijó la persona", async () => {
    const [recomendacion] = (await analizar(COMERCIO_ID)).recomendaciones;

    expect(recomendacion.tipo).toBe(TIPOS_DE_RECOMENDACION.REPONER);
  });

  test("el que quedó afuera del corte de 5 tampoco se contradice", async () => {
    // Con más de 5 bajo el umbral, el sexto no se muestra como reponer. Si el
    // Set se armara con los 5 visibles, ese sexto saldría como baja rotación
    // diciendo "no reponer por ahora" estando por debajo de su mínimo.
    const sexto = "66666666-6666-6666-6666-666666666666";

    productosParaReponer.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) =>
        faltante({
          id: i === 5 ? sexto : `bajo-${i}`,
          nombre: `Bajo el umbral ${i}`,
          umbralMinimo: 10,
          enStock: 5,
        }),
      ),
    );
    rotacionDeProductos.mockResolvedValue(
      rotacion({
        productos: [quieto({ id: sexto, nombre: "Bajo el umbral 5" })],
      }),
    );

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.REPONER)).toHaveLength(5);
    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toEqual([]);
  });

  test("un producto sin umbral configurado sí puede salir como parado", async () => {
    // Umbral 0 no se recomienda reponer, pero tampoco hay un mínimo que
    // contradecir: decir que no se está vendiendo es información útil.
    const ID_SIN_UMBRAL = "55555555-5555-5555-5555-555555555555";

    productosParaReponer.mockResolvedValue([
      faltante({ id: ID_SIN_UMBRAL, nombre: "Sin Umbral", umbralMinimo: 0 }),
    ]);
    rotacionDeProductos.mockResolvedValue(
      rotacion({
        productos: [quieto({ id: ID_SIN_UMBRAL, nombre: "Sin Umbral" })],
      }),
    );

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.REPONER)).toEqual([]);
    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toHaveLength(
      1,
    );
  });

  test("otro producto parado sí sale, no se descarta de más", async () => {
    rotacionDeProductos.mockResolvedValue(
      rotacion({
        productos: [
          quieto({ id: ID, nombre: "Yerba Parada", enStock: 5 }),
          quieto({ id: "44444444-4444-4444-4444-444444444444", nombre: "Otro" }),
        ],
      }),
    );

    const quietos = deTipo(
      await analizar(COMERCIO_ID),
      TIPOS_DE_RECOMENDACION.BAJA_ROTACION,
    );

    expect(quietos.map((una) => una.producto.nombre)).toEqual(["Otro"]);
  });
});

describe("analizar — umbral mínimo en cero", () => {
  test("un producto sin umbral configurado no se recomienda reponer", async () => {
    // 0 es el default del schema (HU-9) y lo que la importación de HU-7 escribe
    // con la celda vacía: no es un umbral bajo, es la ausencia de uno. Salía
    // como "el mínimo que fijaste es 0 unidades, así que convendría hacer un
    // pedido", empujado sin que nadie lo pida.
    productosParaReponer.mockResolvedValue([
      faltante({ nombre: "Sin Umbral", enStock: 0, umbralMinimo: 0 }),
    ]);

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.REPONER)).toEqual([]);
  });

  test("con umbral 1 sí se recomienda: es un umbral de verdad", async () => {
    productosParaReponer.mockResolvedValue([
      faltante({ nombre: "Con Umbral", enStock: 0, umbralMinimo: 1 }),
    ]);

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.REPONER)).toHaveLength(1);
  });

  test("los de umbral 0 no le ocupan el lugar a los que sí lo tienen", async () => {
    // Por eso se le piden más candidatos a la consulta de los que se devuelven:
    // si se pidieran cinco, cinco productos sin umbral taparían a los reales.
    productosParaReponer.mockResolvedValue([
      ...Array.from({ length: 6 }, (_, i) =>
        faltante({ id: `cero-${i}`, nombre: `Sin umbral ${i}`, umbralMinimo: 0 }),
      ),
      faltante({ id: "real", nombre: "Harina 000", umbralMinimo: 10 }),
    ]);

    const reponer = deTipo(
      await analizar(COMERCIO_ID),
      TIPOS_DE_RECOMENDACION.REPONER,
    );

    expect(reponer).toHaveLength(1);
    expect(reponer[0].producto.nombre).toBe("Harina 000");
  });

  test("le pide a la consulta más candidatos que los que devuelve", async () => {
    await analizar(COMERCIO_ID);

    const { limite } = productosParaReponer.mock.calls[0][1];

    expect(limite).toBeGreaterThan(5);
  });
});

describe("analizar — compuerta de histórico", () => {
  test("con menos ventas que el mínimo no sale ninguna baja rotación", async () => {
    rotacionDeProductos.mockResolvedValue(
      rotacion({ ventasDelComercio: 2, productos: [quieto(), quieto()] }),
    );

    const resultado = await analizar(COMERCIO_ID);

    // Serían todos los productos del comercio, y una recomendación que aplica
    // a todo el catálogo no recomienda nada.
    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toEqual([]);
    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.SIN_HISTORIAL)).toHaveLength(
      1,
    );
  });

  test("la de sin_historial explica por qué y no culpa al catálogo", async () => {
    rotacionDeProductos.mockResolvedValue(
      rotacion({ ventasDelComercio: 0, productos: [quieto()] }),
    );

    const [recomendacion] = deTipo(
      await analizar(COMERCIO_ID),
      TIPOS_DE_RECOMENDACION.SIN_HISTORIAL,
    );

    expect(recomendacion.producto).toBeNull();
    expect(recomendacion.prioridad).toBe("baja");
    expect(recomendacion.texto).toContain("Registrá tus ventas");
    expect(recomendacion.porQue).toContain("0 ventas");
    expect(recomendacion.porQue).toContain("al menos 3");
    expect(recomendacion.datos).toMatchObject({
      ventasEnVentana: 0,
      ventasMinimas: 3,
    });
  });

  test("con el mínimo justo ya analiza la rotación", async () => {
    rotacionDeProductos.mockResolvedValue(
      rotacion({ ventasDelComercio: 3, productos: [quieto()] }),
    );

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toHaveLength(
      1,
    );
    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.SIN_HISTORIAL)).toEqual([]);
  });

  test("la reposición se sigue recomendando sin histórico de ventas", async () => {
    // Es lo que hace útil al endpoint en un comercio recién cargado: no tener
    // ventas registradas no impide ver que algo está en cero.
    productosParaReponer.mockResolvedValue([faltante()]);
    rotacionDeProductos.mockResolvedValue(rotacion({ ventasDelComercio: 0 }));

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.REPONER)).toHaveLength(1);
    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.SIN_HISTORIAL)).toHaveLength(
      1,
    );
  });

  test("el piso se puede mover desde el .env", async () => {
    process.env.RECOMENDACIONES_VENTAS_MINIMAS = "1";
    rotacionDeProductos.mockResolvedValue(
      rotacion({ ventasDelComercio: 1, productos: [quieto()] }),
    );

    const resultado = await analizar(COMERCIO_ID);

    expect(deTipo(resultado, TIPOS_DE_RECOMENDACION.BAJA_ROTACION)).toHaveLength(
      1,
    );
  });
});

describe("analizar — multi-tenant", () => {
  test("las dos consultas corren contra el comercio de la sesión", async () => {
    await analizar(COMERCIO_ID);

    expect(productosParaReponer).toHaveBeenCalledWith(COMERCIO_ID, {
      limite: expect.any(Number),
    });
    expect(rotacionDeProductos).toHaveBeenCalledWith(COMERCIO_ID, { dias: 30 });
    expect(productosParaReponer).not.toHaveBeenCalledWith(
      OTRO_COMERCIO_ID,
      expect.anything(),
    );
  });
});

/* ------------------------------------------------------------------ */

describe("resumenPorPlantilla", () => {
  test("sin recomendaciones devuelve el mensaje de que no hay nada", () => {
    expect(resumenPorPlantilla([])).toBe(RESUMEN_SIN_RECOMENDACIONES);
  });

  test("cuenta por tipo y concuerda el singular", () => {
    const resumen = resumenPorPlantilla([
      { tipo: TIPOS_DE_RECOMENDACION.REPONER, texto: "a" },
      { tipo: TIPOS_DE_RECOMENDACION.BAJA_ROTACION, texto: "b" },
      { tipo: TIPOS_DE_RECOMENDACION.BAJA_ROTACION, texto: "c" },
    ]);

    expect(resumen).toContain("1 producto para reponer");
    expect(resumen).toContain("2 productos que no se están vendiendo");
  });

  test("con solo sin_historial no dice que encontró nada", () => {
    const resumen = resumenPorPlantilla([
      { tipo: TIPOS_DE_RECOMENDACION.SIN_HISTORIAL, texto: "a" },
    ]);

    expect(resumen).not.toContain("encontré");
    expect(resumen.trim()).not.toBe("");
  });
});

/* ------------------------------------------------------------------ */

describe("recomendar — camino con el modelo", () => {
  beforeEach(() => {
    productosParaReponer.mockResolvedValue([faltante()]);
  });

  test("devuelve el resumen del modelo en modo ia", async () => {
    const resultado = await recomendar(COMERCIO_ID);

    expect(resultado.modo).toBe("ia");
    expect(resultado.resumen).toBe(
      "Tenés harina en cero y la yerba parada. Yo arrancaría por la harina.",
    );
  });

  test("el modelo no reescribe ni una cifra de las recomendaciones", async () => {
    consultarModelo.mockResolvedValue({
      texto: "Tenés 999 kg de harina de sobra.",
      herramientasUsadas: [],
      uso: USO,
    });

    const [recomendacion] = (await recomendar(COMERCIO_ID)).recomendaciones;

    // El resumen puede decir cualquier cosa; el texto y los datos de cada
    // recomendación los sigue armando el sistema.
    expect(recomendacion.texto).toContain("No te queda nada de Harina 000");
    expect(recomendacion.datos.enStock).toBe(0);
  });

  test("no le da herramientas ni le cuenta de qué comercio se trata", async () => {
    await recomendar(COMERCIO_ID);

    const pedido = consultarModelo.mock.calls[0][0];

    // Sin tool calling: los datos ya están calculados y van en el pedido. Y el
    // comercio no viaja, igual que en HU-26 no es un argumento que el modelo
    // pueda elegir.
    expect(pedido.herramientas).toEqual({});
    expect(pedido.pregunta).not.toContain(COMERCIO_ID);
    expect(pedido.instrucciones).not.toContain(COMERCIO_ID);
    expect(pedido.pregunta).toContain("Harina 000");
  });

  test("deja la línea de costo en la consola", async () => {
    await recomendar(COMERCIO_ID);

    expect(avisosDeCosto).toHaveBeenCalledWith(
      expect.stringContaining("google/gemini-2.5-flash"),
    );
  });
});

describe("recomendar — modo limitado (HU-28)", () => {
  beforeEach(() => {
    productosParaReponer.mockResolvedValue([faltante()]);
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  /** Lo que tiene que valer en los cuatro caminos degradados. */
  async function esperarDegradadoCompleto() {
    const resultado = await recomendar(COMERCIO_ID);

    expect(resultado.modo).toBe("limitado");
    expect(resultado.resumen.trim()).not.toBe("");
    // Lo único que se degrada es el párrafo de arriba: la lista llega entera.
    expect(resultado.recomendaciones).toHaveLength(1);
    expect(resultado.recomendaciones[0].texto).toContain("Harina 000");

    return resultado;
  }

  test("sin proveedor configurado, y sin llamar a nadie", async () => {
    hayProveedorConfigurado.mockReturnValue(false);

    await esperarDegradadoCompleto();

    expect(consultarModelo).not.toHaveBeenCalled();
  });

  test("si el proveedor falla", async () => {
    consultarModelo.mockRejectedValue(new Error("503 del proveedor"));

    expect((await esperarDegradadoCompleto()).modo).toBe("limitado");
  });

  test("si el proveedor corta por timeout", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    consultarModelo.mockRejectedValue(timeout);

    expect((await esperarDegradadoCompleto()).modo).toBe("limitado");
  });

  test("si el modelo contesta vacío", async () => {
    consultarModelo.mockResolvedValue({
      texto: "   ",
      herramientasUsadas: [],
      uso: USO,
    });

    expect((await esperarDegradadoCompleto()).modo).toBe("limitado");
  });

  test("un pedido que no escribió nada igual deja su línea de costo", async () => {
    // Es el pedido que más interesa ver en la consola: se pagó y no sirvió.
    // Loguearlo después del `return` lo dejaba invisible.
    consultarModelo.mockResolvedValue({
      texto: "",
      herramientasUsadas: [],
      uso: USO,
    });

    await recomendar(COMERCIO_ID);

    expect(avisosDeCosto).toHaveBeenCalledWith(
      expect.stringContaining("google/gemini-2.5-flash"),
    );
  });

  test("un fallo del proveedor no se propaga como excepción", async () => {
    consultarModelo.mockRejectedValue(new Error("explotó"));

    await expect(recomendar(COMERCIO_ID)).resolves.toBeDefined();
  });
});

describe("recomendar — sin nada que recomendar", () => {
  test("lista vacía con mensaje, y sin gastar crédito", async () => {
    const resultado = await recomendar(COMERCIO_ID);

    expect(resultado.recomendaciones).toEqual([]);
    expect(resultado.resumen).toBe(RESUMEN_SIN_RECOMENDACIONES);
    expect(resultado.modo).toBe("limitado");
    // No se le pregunta al modelo para decir "todo en orden": el crédito del
    // Gateway es uno solo para los tres integrantes.
    expect(consultarModelo).not.toHaveBeenCalled();
  });

  test("igual informa la ventana que analizó", async () => {
    const resultado = await recomendar(COMERCIO_ID);

    expect(resultado.ventana).toEqual({ dias: 30, desde: DESDE });
    expect(resultado.generadoEn).toBeInstanceOf(Date);
  });
});

describe("recomendar — caché del resumen", () => {
  beforeEach(() => {
    productosParaReponer.mockResolvedValue([faltante()]);
  });

  test("dos pedidos seguidos del mismo comercio pagan una sola consulta", async () => {
    const primero = await recomendar(COMERCIO_ID);
    const segundo = await recomendar(COMERCIO_ID);

    expect(consultarModelo).toHaveBeenCalledTimes(1);
    expect(segundo.resumen).toBe(primero.resumen);
    expect(segundo.modo).toBe("ia");
  });

  test("si cambian las recomendaciones, se vuelve a redactar", async () => {
    await recomendar(COMERCIO_ID);

    productosParaReponer.mockResolvedValue([
      faltante({ enStock: 4, faltanteHastaElUmbral: 6 }),
    ]);
    await recomendar(COMERCIO_ID);

    // El TTL acota cuánto dura; la huella garantiza que no quede viejo.
    expect(consultarModelo).toHaveBeenCalledTimes(2);
  });

  test("dos comercios no comparten el resumen", async () => {
    await recomendar(COMERCIO_ID);
    await recomendar(OTRO_COMERCIO_ID);

    expect(consultarModelo).toHaveBeenCalledTimes(2);
  });

  test("las recomendaciones no se cachean: se recalculan en cada pedido", async () => {
    await recomendar(COMERCIO_ID);
    await recomendar(COMERCIO_ID);

    // Lo que se cachea es el párrafo del modelo, no el análisis. El análisis
    // es al vuelo justamente para que no haya que invalidarlo.
    expect(rotacionDeProductos).toHaveBeenCalledTimes(2);
  });
});
