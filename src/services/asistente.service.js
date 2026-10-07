import { tool } from "ai";
import { z } from "zod";
import { ErrorDeNegocio } from "../lib/errores.js";
import { consultarModelo, hayProveedorConfigurado } from "../lib/llm.js";
import {
  TIPOS_DE_MOVIMIENTO,
  movimientosRecientes,
  productosParaReponer,
  resumenDeActividad,
  stockDeProducto,
} from "./asistente.consultas.service.js";
import { responderPorReglas } from "./asistente.reglas.service.js";

/**
 * Asistente Inteligente: consulta en lenguaje natural (HU-26, RF6, RNF2).
 *
 * Orquesta las tres piezas y no hace ninguna de las tres: le da al modelo las
 * consultas de `asistente.consultas.service.js` como herramientas, le pone un
 * limite de tiempo, y si algo falla delega en las reglas de HU-28.
 *
 * El contrato de salida es siempre el mismo, venga de donde venga la respuesta:
 *
 *   { respuesta: string, modo: "ia" | "limitado", herramientasUsadas: string[] }
 *
 * `modo` es lo que el frontend necesita para avisarle al usuario que esta
 * viendo una respuesta limitada, que es un criterio de aceptacion de HU-28.
 * Nunca es opcional: una respuesta sin `modo` obligaria a la pantalla a
 * adivinar, y adivinaria que todo esta bien.
 */

/** Largo maximo de una pregunta. */
const PREGUNTA_MAXIMA = 500;

/**
 * Que es el asistente y que no puede hacer.
 *
 * Las reglas de aca no son decoracion: son lo que separa "el sistema calcula y
 * el modelo redacta" de un chatbot que inventa saldos. Las tres primeras son
 * las que sostienen esa separacion.
 */
const INSTRUCCIONES = `Sos el asistente de un sistema de gestion de stock para comercios chicos.
Te habla la persona que atiende el negocio, que no es tecnica.

Reglas:
- Respondé unicamente con datos que hayas obtenido de las herramientas. Nunca inventes cantidades, nombres de productos ni fechas.
- Si una herramienta no devuelve resultados, decilo con todas las letras ("no encontre ningun producto que se llame asi") en vez de suponer.
- Si la pregunta no se puede contestar con las herramientas que tenes, explicá que eso todavia no lo podes consultar. No pidas disculpas de más.
- Escribí en español rioplatense, breve y directo. Dos o tres oraciones alcanzan.
- Usá listas solo cuando enumeres productos o movimientos.
- No hables de "herramientas", "consultas", "base de datos" ni "sistema": la persona quiere saber de su negocio.
- Las cantidades van con su unidad de medida cuando la tengas.

Todavia no tenes acceso a proveedores ni a precios: si te preguntan por eso, decí que por ahora no lo podes consultar.`;

/**
 * Las consultas expuestas como herramientas del modelo.
 *
 * Se arman por pedido y no una sola vez en el modulo, porque cada `execute`
 * cierra sobre el `comercioId` de esta sesion. Es la pieza que hace que el
 * multi-tenant no dependa del modelo: el `comercioId` no es un argumento que el
 * LLM pueda elegir ni ver, lo pone el closure. Aunque el usuario escriba el id
 * de otro comercio en la pregunta, no hay por donde entre.
 */
function armarHerramientas(comercioId) {
  return {
    productosParaReponer: tool({
      description:
        "Lista los productos cuyo stock total esta en el umbral minimo o por debajo. Usala para '¿que tengo que reponer?', '¿que me esta faltando?', '¿que productos estan bajos?'.",
      inputSchema: z.object({
        limite: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Cuantos productos devolver. Por defecto 10."),
      }),
      execute: ({ limite }) => productosParaReponer(comercioId, { limite }),
    }),

    stockDeProducto: tool({
      description:
        "Stock de los productos que coinciden con un nombre o un codigo de barras, discriminado por ubicacion. Usala para '¿cuanto me queda de X?', '¿tengo X?', '¿donde esta X?'.",
      inputSchema: z.object({
        busqueda: z
          .string()
          .min(1)
          .describe(
            "Parte del nombre del producto, o su codigo de barras completo.",
          ),
      }),
      execute: ({ busqueda }) => stockDeProducto(comercioId, { busqueda }),
    }),

    movimientosRecientes: tool({
      description:
        "Ultimos movimientos de stock del comercio. Usala para '¿que vendi esta semana?', '¿hubo mermas?', '¿que entro ayer?'.",
      inputSchema: z.object({
        dias: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Cuantos dias hacia atras mirar. Por defecto 7."),
        tipo: z
          .enum(TIPOS_DE_MOVIMIENTO)
          .optional()
          .describe("Filtra por un tipo de movimiento."),
        limite: z.number().int().min(1).max(50).optional(),
      }),
      execute: ({ dias, tipo, limite }) =>
        movimientosRecientes(comercioId, { dias, tipo, limite }),
    }),

    resumenDeActividad: tool({
      description:
        "Cuantos movimientos y cuantas unidades se movieron, agrupado por tipo. Usala para '¿como viene el dia?', '¿como fue la semana?'.",
      inputSchema: z.object({
        dias: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Ventana en dias. Por defecto 1, que es el dia de hoy."),
      }),
      execute: ({ dias }) => resumenDeActividad(comercioId, { dias }),
    }),
  };
}

/**
 * Valida la pregunta antes de gastar un pedido al proveedor.
 *
 * Pura y sin base, como `validarDatosProducto` y `validarDatosMovimiento`, para
 * poder testearla sin levantar nada.
 */
export function validarPregunta(datosCrudos = {}) {
  const { pregunta } = datosCrudos;

  if (typeof pregunta !== "string" || pregunta.trim() === "") {
    throw new ErrorDeNegocio("Escribí una pregunta para el asistente", 400);
  }

  const limpia = pregunta.trim();

  if (limpia.length > PREGUNTA_MAXIMA) {
    throw new ErrorDeNegocio(
      `La pregunta no puede superar los ${PREGUNTA_MAXIMA} caracteres`,
      400,
    );
  }

  return limpia;
}

/**
 * Responde una pregunta en lenguaje natural sobre los datos del comercio.
 *
 * El camino feliz es el modelo con herramientas. Se cae al modo limitado en
 * tres casos, y los tres son esperables en produccion: que no haya key
 * configurada, que el proveedor tarde mas que el timeout, o que devuelva un
 * error. Ninguno de los tres es un 500 — el asistente sigue contestando, que es
 * exactamente lo que pide HU-28.
 *
 * Tambien cae al modo limitado si el modelo contesta vacio. Pasa cuando el
 * pedido se corta por el tope de pasos: se gastaron las llamadas a herramientas
 * y nunca redacto. Sin este chequeo la pantalla mostraria un globo en blanco,
 * que se lee como un bug y no como un modo degradado.
 */
export async function responder(comercioId, datosCrudos = {}) {
  const pregunta = validarPregunta(datosCrudos);

  if (!hayProveedorConfigurado()) {
    return await responderEnModoLimitado(comercioId, pregunta);
  }

  try {
    const { texto, herramientasUsadas, uso } = await consultarModelo({
      instrucciones: INSTRUCCIONES,
      pregunta,
      herramientas: armarHerramientas(comercioId),
    });

    // Una linea por consulta con lo que costo. El credito del Gateway es uno
    // solo para los tres integrantes, y sin esto nadie ve cuanto gasta lo que
    // esta probando hasta que se agota para todos.
    console.info(
      `[asistente] ${uso.modelo} | ${uso.entrada} tokens entrada, ` +
        `${uso.salida} salida | ~US$ ${uso.costoUsd.toFixed(5)}`,
    );

    if (!texto || texto.trim() === "") {
      return await responderEnModoLimitado(comercioId, pregunta);
    }

    return { respuesta: texto.trim(), modo: "ia", herramientasUsadas };
  } catch (error) {
    // Se loguea entero y no se propaga: para el usuario esto no es un error,
    // es una respuesta mas pobre. Sin este log, un proveedor caido se ve igual
    // que uno sin configurar y no hay con que diagnosticarlo.
    console.error("[asistente] el proveedor de LLM fallo:", error);

    return await responderEnModoLimitado(comercioId, pregunta);
  }
}

/**
 * La vuelta por las reglas, con el `modo` ya marcado.
 *
 * Existe como funcion aparte para que los tres caminos de arriba no repitan la
 * forma de la respuesta, y para que quede un solo lugar que hable con HU-28.
 */
async function responderEnModoLimitado(comercioId, pregunta) {
  const respuesta = await responderPorReglas(comercioId, pregunta);

  return { respuesta, modo: "limitado", herramientasUsadas: [] };
}
