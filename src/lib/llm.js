import { createGateway, generateText, stepCountIs } from "ai";

/**
 * Unico punto del backend que habla con el proveedor de LLM (ADR-2, T-08).
 *
 * Todo lo que es especifico del proveedor —la key, el nombre del modelo, los
 * parametros que solo entiende el— vive aca adentro y no se filtra al resto del
 * codigo. `asistente.service.js` le pasa una pregunta y una lista de
 * herramientas y recibe texto: no sabe con quien hablo.
 *
 * Esa frontera es la que hace reversible la decision del ADR-2. Cambiar de
 * proveedor, o cambiar el AI SDK de Vercel por el SDK oficial de quien sea, es
 * reescribir este archivo y ninguno mas: ni los services, ni los controllers,
 * ni el frontend, ni las HU-27 y HU-28 de los demas se enteran.
 *
 * Se habla via el AI Gateway de Vercel y no contra la API de Google directo.
 * Es lo que hace cierta en la practica la promesa del ADR-2: una sola cuenta y
 * una sola key para todos los proveedores, y el modelo elegido por un string
 * con forma `proveedor/modelo`.
 */

/**
 * Modelos que este backend acepta usar, con su precio en USD por millon de
 * tokens (precios del AI Gateway, consultados en /v1/models).
 *
 * La cuenta del Gateway es UNA SOLA y la comparten los tres integrantes, con
 * un credito de 5 USD por mes. Por eso la eleccion del modelo no es libre: un
 * `LLM_MODELO=anthropic/claude-opus-4` en el .env de cualquiera cuesta 75 USD
 * por millon de tokens de salida, 187 veces el modelo mas barato de esta
 * lista, y se come el credito de todos en una tarde. Que aparezca un modelo
 * nuevo aca es una decision del equipo, no de un .env.
 *
 * El techo es 2,50 USD/1M de salida. Todos tienen tool calling, que es lo que
 * HU-26 necesita para consultar los datos en vez de inventarlos.
 */
export const MODELOS_PERMITIDOS = {
  "google/gemini-2.5-flash-lite": { entrada: 0.1, salida: 0.4 },
  "google/gemini-3.1-flash-lite": { entrada: 0.25, salida: 1.5 },
  "google/gemini-2.5-flash": { entrada: 0.3, salida: 2.5 },
};

/**
 * Modelo por defecto.
 *
 * Flash y no Pro por RNF2: el limite es de 5 segundos de punta a punta, con dos
 * viajes al modelo adentro (uno para elegir la herramienta y otro para redactar
 * con el resultado). Y barato por lo de arriba: el credito es compartido.
 */
const MODELO_POR_DEFECTO = "google/gemini-2.5-flash";

/**
 * Cuanto esperamos al modelo antes de dar la vuelta por el modo degradado.
 *
 * Son 4 segundos y no 5 a proposito: RNF2 mide lo que tarda el usuario en ver
 * una respuesta, y despues de cortar todavia hay que resolver el fallback por
 * reglas (HU-28) y serializar. El segundo que queda es para eso.
 */
export const TIMEOUT_MS = 4000;

/**
 * Cuantas veces puede llamar a una herramienta antes de tener que contestar.
 *
 * Tres pasos alcanzan para el caso real —consultar, quizas cruzar con una
 * segunda consulta, y redactar— y ponen un techo duro a lo que puede tardar y
 * costar un solo pedido. Cada paso es un viaje al modelo que se paga.
 */
const PASOS_MAXIMOS = 3;

/**
 * Tope de tokens que el modelo puede escribir por paso.
 *
 * La respuesta que pedimos es de dos o tres oraciones, que son menos de 150
 * tokens. El tope existe para el caso que no esperamos: un modelo que se
 * desboca escribiendo no puede gastar mas que esto por paso. Es la salida, que
 * es la parte cara del precio, la que se acota.
 */
const TOKENS_DE_SALIDA_MAXIMOS = 400;

export function hayProveedorConfigurado() {
  return Boolean(obtenerApiKey());
}

/**
 * La key, con los dos nombres que se usan en la practica.
 *
 * `LLM_API_KEY` es el del proyecto, y esta en el .env.example desde el Sprint
 * 0. `AI_GATEWAY_API_KEY` es el que usa la documentacion de Vercel, asi que es
 * el que va a poner quien copie de ahi. Aceptar los dos cuesta una linea y
 * evita el rato de buscar por que el asistente contesta siempre en modo
 * limitado cuando la key esta puesta.
 */
function obtenerApiKey() {
  return process.env.LLM_API_KEY || process.env.AI_GATEWAY_API_KEY;
}

/**
 * El modelo a usar, siempre uno de la lista.
 *
 * Si `LLM_MODELO` pide uno que no esta, se usa el default y se avisa fuerte en
 * la consola, en vez de tirar error. Tirar error dejaria el asistente siempre
 * en modo limitado, que se confunde con "el proveedor esta caido" y no lleva a
 * nadie a mirar el .env. El aviso, en cambio, dice que paso y como se arregla.
 */
let avisoYaMostrado = false;

export function resolverModelo(pedido = process.env.LLM_MODELO) {
  if (!pedido) {
    return MODELO_POR_DEFECTO;
  }

  if (Object.hasOwn(MODELOS_PERMITIDOS, pedido)) {
    return pedido;
  }

  if (!avisoYaMostrado) {
    avisoYaMostrado = true;
    console.warn(
      `[asistente] LLM_MODELO="${pedido}" no esta en la lista de modelos permitidos ` +
        `(src/lib/llm.js). Se usa ${MODELO_POR_DEFECTO} para no gastar el credito ` +
        `compartido del equipo. Permitidos: ${Object.keys(MODELOS_PERMITIDOS).join(", ")}.`,
    );
  }

  return MODELO_POR_DEFECTO;
}

/**
 * Cuanto costo una consulta, en USD, a partir de los tokens que reporto el SDK.
 *
 * Es una estimacion con los precios de la lista, no lo que factura Vercel: la
 * fuente de verdad es GET /v1/credits del Gateway. Sirve para que cada
 * desarrollador vea en su consola cuanto le cuesta lo que esta probando.
 */
export function estimarCostoUsd(modelo, { entrada = 0, salida = 0 }) {
  if (!Object.hasOwn(MODELOS_PERMITIDOS, modelo)) {
    return 0;
  }

  const precio = MODELOS_PERMITIDOS[modelo];

  return (entrada * precio.entrada + salida * precio.salida) / 1_000_000;
}

/**
 * El cliente se arma una sola vez, la primera vez que se lo usa.
 *
 * No al importar el modulo: los tests importan este archivo sin key y no tienen
 * por que explotar, y `dotenv` puede no haber corrido todavia segun quien
 * importe a quien primero.
 */
let proveedor;

function obtenerProveedor() {
  if (!proveedor) {
    // La key se pasa explicita en vez de dejar que el SDK lea
    // `AI_GATEWAY_API_KEY` del ambiente por su cuenta: asi el nombre de la
    // variable lo decide este proyecto y no el paquete.
    proveedor = createGateway({ apiKey: obtenerApiKey() });
  }

  return proveedor;
}

/**
 * Le hace la pregunta al modelo dandole herramientas para consultar los datos.
 *
 * Devuelve el texto redactado, con que herramientas lo armo, y cuanto consumio.
 * Las herramientas no son decorativas: dejan ver, en los tests y en un bug
 * report, si contesto mirando los datos o si improviso. El consumo existe
 * porque el credito es compartido y cada consulta se paga.
 *
 * Cualquier fallo —sin key, timeout, 429, credito agotado, el proveedor
 * caido— sale como excepcion. Quien decide que hacer con eso es
 * `asistente.service.js`, que es el que conoce el modo degradado.
 */
export async function consultarModelo({
  instrucciones,
  pregunta,
  herramientas,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!hayProveedorConfigurado()) {
    throw new Error("No hay LLM_API_KEY configurada");
  }

  const modelo = resolverModelo();

  const resultado = await generateText({
    model: obtenerProveedor()(modelo),
    system: instrucciones,
    prompt: pregunta,
    tools: herramientas,
    stopWhen: stepCountIs(PASOS_MAXIMOS),
    maxOutputTokens: TOKENS_DE_SALIDA_MAXIMOS,
    // El AI SDK aborta solo al cumplirse, lo que hace innecesario manejar el
    // `AbortController` a mano.
    timeout: timeoutMs,
    // Un reintento contra un proveedor que tarda es tiempo del usuario gastado
    // en algo que ya sabemos que va lento, y un pedido mas que se paga. Con
    // RNF2 encima conviene fallar rapido y contestar en modo limitado.
    maxRetries: 0,
    // Ajustes propios de cada proveedor. El Gateway pasa de largo los que no
    // le corresponden al modelo elegido.
    providerOptions: {
      google: {
        // Gemini 2.5 razona antes de contestar salvo que se le diga que no.
        // Para "¿que tengo que reponer?" ese razonamiento no agrega nada, y
        // si agrega segundos y tokens de salida, que son los caros.
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  });

  // `totalUsage` y no `usage`: con herramientas hay varios pasos, y `usage` es
  // solo el ultimo. Lo que se paga es la suma.
  const entrada = resultado.totalUsage?.inputTokens ?? 0;
  const salida = resultado.totalUsage?.outputTokens ?? 0;

  return {
    texto: resultado.text,
    herramientasUsadas: resultado.toolCalls.map((llamada) => llamada.toolName),
    uso: {
      modelo,
      entrada,
      salida,
      costoUsd: estimarCostoUsd(modelo, { entrada, salida }),
    },
  };
}
