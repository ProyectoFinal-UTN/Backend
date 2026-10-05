import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * Unitarios del Asistente Inteligente (HU-26).
 *
 * Es el primer test del repo que mockea modulos, y hay una sola razon: el
 * camino feliz de esta HU llama a una API paga de un tercero. Correrla de
 * verdad en cada `npm test` gastaria cuota y ataria la suite a que el proveedor
 * este arriba, que es justo lo que HU-28 da por sentado que va a fallar.
 *
 * Se mockea el borde y nada mas: `lib/llm.js`, que es el unico archivo que
 * habla con el proveedor, y las consultas, para poder ver con que `comercioId`
 * las llamaron. La logica de orquestacion —validar, elegir modo, armar la
 * respuesta— corre de verdad.
 *
 * `jest.unstable_mockModule` necesita que el import del modulo bajo prueba sea
 * dinamico y posterior, por eso el `await import` adentro de cada bloque y no
 * arriba de todo.
 */

const consultarModelo = jest.fn();
const hayProveedorConfigurado = jest.fn();
const productosParaReponer = jest.fn(async () => []);
const stockDeProducto = jest.fn(async () => []);
const movimientosRecientes = jest.fn(async () => ({ movimientos: [] }));
const resumenDeActividad = jest.fn(async () => ({ porTipo: [] }));

jest.unstable_mockModule("../src/lib/llm.js", () => ({
  consultarModelo,
  hayProveedorConfigurado,
  TIMEOUT_MS: 4000,
}));

jest.unstable_mockModule("../src/services/asistente.consultas.service.js", () => ({
  TIPOS_DE_MOVIMIENTO: ["compra", "venta", "merma", "ajuste", "transferencia"],
  productosParaReponer,
  stockDeProducto,
  movimientosRecientes,
  resumenDeActividad,
}));

const { responder, validarPregunta } = await import(
  "../src/services/asistente.service.js"
);

const COMERCIO_ID = "123e4567-e89b-12d3-a456-426614174000";
const OTRO_COMERCIO_ID = "223e4567-e89b-12d3-a456-426614174001";

const USO = {
  modelo: "google/gemini-2.5-flash",
  entrada: 1200,
  salida: 60,
  costoUsd: 0.00051,
};

beforeEach(() => {
  jest.clearAllMocks();
  // La linea de costo por consulta es para la consola del desarrollador, no
  // para la salida de la suite.
  jest.spyOn(console, "info").mockImplementation(() => {});
  hayProveedorConfigurado.mockReturnValue(true);
  consultarModelo.mockResolvedValue({
    texto: "Te quedan 3 kg de harina.",
    herramientasUsadas: ["stockDeProducto"],
    uso: USO,
  });
});

/** Ejecuta el validador y devuelve el error que tiro, para poder mirar status. */
function errorDe(datos) {
  try {
    validarPregunta(datos);
  } catch (error) {
    return error;
  }

  throw new Error("Se esperaba que la validación fallara y no falló");
}

describe("validarPregunta", () => {
  test("recorta los espacios de los bordes", () => {
    expect(validarPregunta({ pregunta: "  ¿qué repongo?  " })).toBe(
      "¿qué repongo?",
    );
  });

  test("rechaza una pregunta vacía con 400", () => {
    expect(errorDe({ pregunta: "   " }).status).toBe(400);
  });

  test("rechaza que falte la pregunta con 400", () => {
    expect(errorDe({}).status).toBe(400);
  });

  test("rechaza algo que no sea texto con 400", () => {
    // El body lo arma el cliente: un número o un objeto llegan igual de fácil
    // que un string, y sin este chequeo `.trim()` tiraría un TypeError sin
    // status, que saldría como 500.
    expect(errorDe({ pregunta: 42 }).status).toBe(400);
    expect(errorDe({ pregunta: { texto: "hola" } }).status).toBe(400);
  });

  test("rechaza una pregunta de más de 500 caracteres con 400", () => {
    expect(errorDe({ pregunta: "a".repeat(501) }).status).toBe(400);
  });

  test("acepta una de exactamente 500", () => {
    expect(validarPregunta({ pregunta: "a".repeat(500) })).toHaveLength(500);
  });
});

describe("responder — camino con el modelo", () => {
  test("devuelve el texto del modelo en modo ia", async () => {
    const resultado = await responder(COMERCIO_ID, {
      pregunta: "¿cuánta harina tengo?",
    });

    expect(resultado).toEqual({
      respuesta: "Te quedan 3 kg de harina.",
      modo: "ia",
      herramientasUsadas: ["stockDeProducto"],
    });
  });

  test("le manda al modelo la pregunta ya validada, sin los espacios", async () => {
    await responder(COMERCIO_ID, { pregunta: "  ¿qué repongo?  " });

    expect(consultarModelo.mock.calls[0][0].pregunta).toBe("¿qué repongo?");
  });

  test("no llama al proveedor si la pregunta es inválida", async () => {
    await expect(responder(COMERCIO_ID, { pregunta: "" })).rejects.toThrow();

    expect(consultarModelo).not.toHaveBeenCalled();
  });
});

describe("responder — multi-tenant", () => {
  test("ninguna herramienta recibe el comercio como argumento del modelo", async () => {
    await responder(COMERCIO_ID, { pregunta: "¿qué repongo?" });

    const { herramientas } = consultarModelo.mock.calls[0][0];

    // Si el `comercioId` fuera un parámetro del schema, el modelo podría
    // elegirlo, y una pregunta como "mostrame el stock del comercio X" pasaría
    // a ser una fuga de datos entre tenants. Tiene que salir del closure.
    for (const [nombre, definicion] of Object.entries(herramientas)) {
      const campos = Object.keys(definicion.inputSchema.shape ?? {});

      expect(campos).not.toContain("comercioId");
      expect(nombre).toBeTruthy();
    }
  });

  test("las consultas corren contra el comercio de la sesión", async () => {
    await responder(COMERCIO_ID, { pregunta: "¿cuánta harina tengo?" });

    const { herramientas } = consultarModelo.mock.calls[0][0];

    await herramientas.stockDeProducto.execute({ busqueda: "harina" });
    await herramientas.productosParaReponer.execute({});

    expect(stockDeProducto).toHaveBeenCalledWith(COMERCIO_ID, {
      busqueda: "harina",
    });
    expect(productosParaReponer).toHaveBeenCalledWith(COMERCIO_ID, {
      limite: undefined,
    });
    expect(stockDeProducto).not.toHaveBeenCalledWith(
      OTRO_COMERCIO_ID,
      expect.anything(),
    );
  });
});

describe("responder — modo limitado (HU-28)", () => {
  test("cae a reglas si no hay proveedor configurado, sin llamar a nadie", async () => {
    hayProveedorConfigurado.mockReturnValue(false);

    const resultado = await responder(COMERCIO_ID, {
      pregunta: "¿qué repongo?",
    });

    expect(resultado.modo).toBe("limitado");
    expect(resultado.respuesta).not.toBe("");
    expect(resultado.herramientasUsadas).toEqual([]);
    expect(consultarModelo).not.toHaveBeenCalled();
  });

  test("cae a reglas si el proveedor falla", async () => {
    consultarModelo.mockRejectedValue(new Error("503 del proveedor"));
    // El service loguea el error para poder diagnosticarlo; no queremos ese
    // ruido en la salida de la suite.
    jest.spyOn(console, "error").mockImplementation(() => {});

    const resultado = await responder(COMERCIO_ID, {
      pregunta: "¿qué repongo?",
    });

    expect(resultado.modo).toBe("limitado");
  });

  test("cae a reglas si el proveedor corta por timeout", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    consultarModelo.mockRejectedValue(timeout);
    jest.spyOn(console, "error").mockImplementation(() => {});

    const resultado = await responder(COMERCIO_ID, {
      pregunta: "¿qué repongo?",
    });

    expect(resultado.modo).toBe("limitado");
  });

  test("cae a reglas si el modelo contesta vacío", async () => {
    // Pasa de verdad cuando el pedido se corta por el tope de pasos: gastó las
    // llamadas a herramientas y nunca redactó. Sin esto la pantalla mostraría
    // un globo en blanco, que se lee como un bug y no como un modo degradado.
    consultarModelo.mockResolvedValue({
      texto: "   ",
      herramientasUsadas: ["productosParaReponer"],
      uso: USO,
    });

    const resultado = await responder(COMERCIO_ID, {
      pregunta: "¿qué repongo?",
    });

    expect(resultado.modo).toBe("limitado");
    expect(resultado.respuesta.trim()).not.toBe("");
  });

  test("un error de validación sigue siendo un 400 y no una respuesta limitada", async () => {
    // El modo limitado es para cuando falla el proveedor. Una pregunta vacía es
    // un problema del pedido, y taparlo con una respuesta amable dejaría al
    // frontend sin forma de marcar el campo.
    hayProveedorConfigurado.mockReturnValue(false);

    const error = await responder(COMERCIO_ID, { pregunta: "" }).catch(
      (fallo) => fallo,
    );

    expect(error.status).toBe(400);
  });
});
