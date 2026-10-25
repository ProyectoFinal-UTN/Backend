import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * HU-20, criterio 2: "al generar una alerta de reposición, se sugiere el
 * proveedor asociado". Hoy la unica alerta de reposicion que existe es la
 * tarjeta `reponer` de las recomendaciones de HU-27, asi que se prueba ahi.
 *
 * Archivo aparte de tests/asistente.recomendaciones.test.js para no mezclar las
 * reglas de HU-27 con las de esta HU. Mismo esquema de mocks: el LLM y las
 * consultas SQL, nunca la logica. Ningun test llama al modelo real.
 */

const proveedoresDeProductos = jest.fn(async () => new Map());
const productosParaReponer = jest.fn(async () => []);

jest.unstable_mockModule("../src/lib/llm.js", () => ({
  consultarModelo: jest.fn(),
  hayProveedorConfigurado: jest.fn(() => false),
  TIMEOUT_MS: 4000,
}));

jest.unstable_mockModule("../src/services/asistente.consultas.service.js", () => ({
  TIPOS_DE_MOVIMIENTO: ["compra", "venta", "merma", "ajuste", "transferencia"],
  productosParaReponer,
  rotacionDeProductos: jest.fn(async () => ({
    dias: 30,
    desde: new Date("2026-09-06T12:00:00.000Z"),
    ventasDelComercio: 0,
    productos: [],
  })),
  stockDeProducto: jest.fn(async () => []),
  movimientosRecientes: jest.fn(async () => ({ movimientos: [] })),
  resumenDeActividad: jest.fn(async () => ({ porTipo: [] })),
}));

jest.unstable_mockModule("../src/services/productoProveedor.service.js", () => ({
  proveedoresDeProductos,
}));

const { analizar, TIPOS_DE_RECOMENDACION } = await import(
  "../src/services/asistente.recomendaciones.service.js"
);

const COMERCIO_ID = "123e4567-e89b-12d3-a456-426614174000";

function faltante(id, nombre) {
  return {
    id,
    nombre,
    categoria: "Almacén",
    unidadMedida: "unidad",
    umbralMinimo: 10,
    enStock: 0,
    faltanteHastaElUmbral: 10,
  };
}

const HARINA = faltante("22222222-2222-2222-2222-222222222222", "Harina 000");
const YERBA = faltante("33333333-3333-3333-3333-333333333333", "Yerba 1kg");

const DISTRI_SUR = {
  id: "44444444-4444-4444-4444-444444444444",
  nombre: "Distribuidora Sur",
  telefono: "11 5555-0000",
  correo: null,
};
const MAYORISTA = {
  id: "55555555-5555-5555-5555-555555555555",
  nombre: "Mayorista Norte",
  telefono: null,
  correo: "pedidos@norte.com",
};

const reponer = (resultado) =>
  resultado.recomendaciones.filter(
    (una) => una.tipo === TIPOS_DE_RECOMENDACION.REPONER,
  );

beforeEach(() => {
  jest.clearAllMocks();
  proveedoresDeProductos.mockResolvedValue(new Map());
});

describe("Reposición con proveedores asociados (HU-20)", () => {
  test("sugiere los proveedores asociados al producto", async () => {
    productosParaReponer.mockResolvedValue([HARINA]);
    proveedoresDeProductos.mockResolvedValue(
      new Map([[HARINA.id, [DISTRI_SUR, MAYORISTA]]]),
    );

    const [recomendacion] = reponer(await analizar(COMERCIO_ID));

    expect(recomendacion.proveedoresSugeridos).toEqual([DISTRI_SUR, MAYORISTA]);
  });

  test("cada producto lleva los suyos, no los de otro", async () => {
    productosParaReponer.mockResolvedValue([HARINA, YERBA]);
    proveedoresDeProductos.mockResolvedValue(
      new Map([
        [HARINA.id, [DISTRI_SUR]],
        [YERBA.id, [MAYORISTA]],
      ]),
    );

    const [harina, yerba] = reponer(await analizar(COMERCIO_ID));

    expect(harina.proveedoresSugeridos).toEqual([DISTRI_SUR]);
    expect(yerba.proveedoresSugeridos).toEqual([MAYORISTA]);
  });

  test("un producto sin proveedores trae la lista vacía, no el campo ausente", async () => {
    productosParaReponer.mockResolvedValue([HARINA]);

    const [recomendacion] = reponer(await analizar(COMERCIO_ID));

    expect(recomendacion.proveedoresSugeridos).toEqual([]);
  });

  test("pide los proveedores en una sola consulta, del comercio y de los que se muestran", async () => {
    productosParaReponer.mockResolvedValue([HARINA, YERBA]);

    await analizar(COMERCIO_ID);

    expect(proveedoresDeProductos).toHaveBeenCalledTimes(1);
    expect(proveedoresDeProductos).toHaveBeenCalledWith(COMERCIO_ID, [
      HARINA.id,
      YERBA.id,
    ]);
  });

  test("no le pide proveedores a los productos sin umbral (no se recomiendan)", async () => {
    productosParaReponer.mockResolvedValue([
      HARINA,
      { ...YERBA, umbralMinimo: 0 },
    ]);

    await analizar(COMERCIO_ID);

    expect(proveedoresDeProductos).toHaveBeenCalledWith(COMERCIO_ID, [HARINA.id]);
  });

  test("el texto de la tarjeta no cambia: el proveedor va en su propio campo", async () => {
    productosParaReponer.mockResolvedValue([HARINA]);
    proveedoresDeProductos.mockResolvedValue(new Map([[HARINA.id, [DISTRI_SUR]]]));

    const [recomendacion] = reponer(await analizar(COMERCIO_ID));

    expect(recomendacion.texto).not.toContain("Distribuidora Sur");
  });

  test("las recomendaciones que no son de reposición no llevan proveedores", async () => {
    productosParaReponer.mockResolvedValue([]);

    const { recomendaciones } = await analizar(COMERCIO_ID);

    expect(recomendaciones.length).toBeGreaterThan(0);
    for (const una of recomendaciones) {
      expect(una).not.toHaveProperty("proveedoresSugeridos");
    }
  });
});
