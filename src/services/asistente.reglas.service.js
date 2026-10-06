import {
  movimientosRecientes,
  productosParaReponer,
  resumenDeActividad,
  stockDeProducto,
} from "./asistente.consultas.service.js";

/**
 * Modo degradado del asistente (HU-28, SCRUM-119) — mitigación del riesgo R2.
 *
 * Es la respuesta cuando el modelo de lenguaje no está disponible: no hay key
 * configurada, el proveedor tardó más que el timeout o devolvió un error.
 * `asistente.service.js` detecta los tres casos y llama acá, y le pone
 * `modo: "limitado"` a lo que se devuelva: el frontend usa ese campo para
 * avisarle a la persona que la respuesta es limitada.
 *
 * En vez del modelo, reglas: se reconoce la intención de la pregunta por
 * palabras clave, se corre la misma consulta SQL que usaría el modelo
 * (`asistente.consultas.service.js`) y se arma la respuesta con plantillas
 * fijas. Es predecible a propósito: la misma pregunta da siempre la misma
 * respuesta, y lo que no se entiende se dice en vez de adivinarlo.
 *
 * Reconoce cinco intenciones, en este orden (gana la primera que coincide):
 *
 *   1. reponer      "¿qué tengo que reponer?", "¿qué me falta?"
 *   2. resumen      "¿cómo viene el día?", "resumen de la semana"
 *   3. sin datos    proveedores y precios, que todavía no existen (HU-19)
 *   4. movimientos  "¿qué vendí ayer?", "¿hubo mermas?"
 *   5. stock        "¿cuánta yerba me queda?", "¿tengo coca?"
 *   6. ayuda        todo lo demás: explica qué se puede preguntar
 *
 * El orden importa. "¿Cuánto vendí?" tiene "cuánto" (stock) y "vendí"
 * (movimientos), y es una pregunta sobre ventas: por eso movimientos va antes
 * que stock. Y "¿qué tengo que comprar?" es reponer, mientras que "¿qué
 * compré?" es un movimiento: el infinitivo "comprar" se reconoce en reponer,
 * que va primero, y las formas conjugadas en movimientos.
 *
 * Esta función no tira excepciones: es el plan B. Si también fallara, la
 * persona se quedaría sin nada. Ante cualquier error, el texto genérico.
 */

/** Lo que se contesta si las reglas mismas fallan (la base caída, por ejemplo). */
export const MENSAJE_GENERICO =
  "Por ahora no puedo analizar tu pregunta, pero el resto del sistema funciona normalmente. Podés ver el stock en Productos y lo que se movió en Movimientos.";

/**
 * Lo que se contesta a una pregunta sobre proveedores o precios. Sin esta
 * regla, "¿cuánto me cobra el proveedor?" caería en stock por el "cuánto" y la
 * respuesta sería "no encontré ningún producto que se llame «cobra
 * proveedor»", que confunde más de lo que ayuda.
 */
export const MENSAJE_SIN_DATOS =
  "Todavía no tengo información de proveedores ni de precios. Por ahora puedo decirte qué tenés que reponer, cuánto te queda de un producto y cómo vienen tus movimientos.";

/** Lo que se contesta cuando la pregunta no coincide con ninguna regla. */
export const MENSAJE_AYUDA =
  "En este momento solo puedo responder algunas preguntas: qué productos tenés que reponer, cuánto te queda de un producto (por ejemplo: «¿cuánta yerba me queda?»), tus últimos movimientos o ventas, y cómo viene el día.";

/** Cuántos elementos se listan antes de cortar con "…y N más". */
const MAXIMO_EN_LISTA = 5;

/**
 * Las reglas, sobre el texto ya normalizado (minúsculas, sin tildes, sin
 * signos). Normalizar antes es lo que hace que "¿Qué repongo?", "que repongo"
 * y "QUÉ REPONGO" sean la misma pregunta.
 */
const REGLAS = {
  reponer:
    /\b(repon\w*|falt\w*|agotad\w*|minimo|stock bajo|bajo stock|poco stock|comprar|pedir|se (me )?(acab|termin)\w*)\b/,
  resumen:
    /\b(resumen|como (viene|va|fue|anda|vino|estuvo)|que (paso|hubo|se movio)|actividad|balance)\b/,
  sinDatos: /\b(proveedor\w*|precio\w*|cobr\w*|cuesta\w*|vale|valen|costo\w*)\b/,
  stock:
    /\b(cuant\w*|stock|qued\w*|tengo|tenes|hay|existencia\w*|donde)\b/,
};

/**
 * Tipos de movimiento y cómo se los nombra. Las formas de "comprar" son solo
 * las conjugadas en pasado: el infinitivo es una pregunta de reposición.
 */
const TIPOS = [
  { tipo: "venta", patron: /\b(vend\w*|ventas?)\b/ },
  { tipo: "merma", patron: /\b(mermas?|vencid\w*|rot[oa]s?)\b/ },
  { tipo: "ajuste", patron: /\bajust\w*\b/ },
  { tipo: "transferencia", patron: /\btransfer\w*\b/ },
  {
    tipo: "compra",
    patron: /\b(compr(e|o|aste|amos|aron)|compras|entr(o|aron))\b/,
  },
];

/** Una pregunta sobre movimientos sin tipo: "¿qué se movió?", "últimos movimientos". */
const MOVIMIENTOS_SIN_TIPO = /\b(movimientos?|ultim\w*)\b/;

/**
 * Palabras que no son el nombre del producto en una pregunta de stock. Lo que
 * queda después de sacarlas es lo que se busca: "¿cuánta yerba me queda?" →
 * "yerba".
 */
const PALABRAS_DE_RELLENO = new Set([
  "a", "ahora", "al", "aun", "con", "cual", "cuales", "cuanta", "cuantas",
  "cuanto", "cuantos", "de", "del", "disponible", "disponibles", "donde",
  "el", "en", "es", "esta", "estan", "existencia", "existencias", "hay",
  "hoy", "kg", "kilo", "kilos", "la", "las", "litro", "litros", "lo", "los",
  "me", "mi", "mis", "mucho", "muchos", "o", "para", "poco", "pocos", "por",
  "producto", "productos", "que", "queda", "quedan", "quedo", "quedaron",
  "se", "sin", "son", "stock", "te", "tenes", "tengo", "tiene", "tienen",
  "todavia", "un", "una", "unas", "unidad", "unidades", "unos", "y",
]);

/** Minúsculas, sin tildes y sin signos, con los espacios colapsados. */
export function normalizar(texto) {
  return String(texto ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

/**
 * La ventana de tiempo que menciona la pregunta, en días, o `porDefecto`.
 *
 * Las consultas miran hacia atrás desde ahora, así que "hoy" son las últimas
 * 24 horas, no desde la medianoche. Las respuestas lo dicen así.
 */
function diasMencionados(texto, porDefecto) {
  const explicito = texto.match(/\b(\d{1,2}) dias?\b/);
  if (explicito) return Math.min(Math.max(Number(explicito[1]), 1), 90);
  if (/\bhoy\b/.test(texto)) return 1;
  if (/\bayer\b/.test(texto)) return 2;
  if (/\bsemana\b/.test(texto)) return 7;
  if (/\bmes\b/.test(texto)) return 30;
  return porDefecto;
}

/** Lo que se busca en una pregunta de stock, sin las palabras de relleno. */
function terminoBuscado(texto) {
  return texto
    .split(" ")
    .filter((palabra) => palabra && !PALABRAS_DE_RELLENO.has(palabra))
    .join(" ");
}

/**
 * Qué se está preguntando. Pura: no toca la base, así se puede testear sola.
 *
 * Devuelve `{ intencion, ...parametros }`:
 *   { intencion: "reponer" }
 *   { intencion: "resumen", dias }
 *   { intencion: "movimientos", dias, tipo }   (tipo puede ser undefined)
 *   { intencion: "sinDatos" }
 *   { intencion: "stock", busqueda }           (busqueda puede ser "")
 *   { intencion: "ayuda" }
 */
export function detectarIntencion(pregunta) {
  const texto = normalizar(pregunta);

  if (REGLAS.reponer.test(texto)) {
    return { intencion: "reponer" };
  }

  if (REGLAS.resumen.test(texto)) {
    return { intencion: "resumen", dias: diasMencionados(texto, 1) };
  }

  // Antes que movimientos: "¿a qué precio vendo la yerba?" tiene "vendo", pero
  // pregunta por un precio, que es justo lo que todavía no hay.
  if (REGLAS.sinDatos.test(texto)) {
    return { intencion: "sinDatos" };
  }

  const tipo = TIPOS.find(({ patron }) => patron.test(texto))?.tipo;

  if (tipo || MOVIMIENTOS_SIN_TIPO.test(texto)) {
    return { intencion: "movimientos", dias: diasMencionados(texto, 7), tipo };
  }

  if (REGLAS.stock.test(texto)) {
    return { intencion: "stock", busqueda: terminoBuscado(texto) };
  }

  return { intencion: "ayuda" };
}

/* ---------------------------------------------------------------------------
 * Formato de las respuestas
 * ------------------------------------------------------------------------- */

/** "1 unidad", "3 unidades", "2 kg". */
function conUnidad(cantidad, unidadMedida) {
  if (!unidadMedida || unidadMedida === "unidad") {
    return `${cantidad} ${cantidad === 1 ? "unidad" : "unidades"}`;
  }

  return `${cantidad} ${unidadMedida}`;
}

/** "queda 1 unidad", "quedan 3 unidades", "quedan 0 unidades". */
function queda(cantidad, unidadMedida) {
  return `${cantidad === 1 ? "queda" : "quedan"} ${conUnidad(cantidad, unidadMedida)}`;
}

function periodo(dias) {
  return dias === 1 ? "las últimas 24 horas" : `los últimos ${dias} días`;
}

const PLURAL_DE_TIPO = {
  venta: "ventas",
  compra: "compras",
  merma: "mermas",
  ajuste: "ajustes",
  transferencia: "transferencias",
};

const FEMENINOS = new Set(["venta", "compra", "merma", "transferencia"]);

function listar(lineas, cierre) {
  const visibles = lineas.slice(0, MAXIMO_EN_LISTA);
  const resto = lineas.length - visibles.length;

  return [
    ...visibles.map((linea) => `• ${linea}`),
    ...(resto > 0 ? [`…y ${resto} más.${cierre ? ` ${cierre}` : ""}`] : []),
  ].join("\n");
}

/**
 * "06/10", en horario de Argentina.
 *
 * Se arma a mano a partir de las partes y no con `toLocaleDateString`: la
 * versión de ICU que trae Node cambia según la instalación, y la de Windows
 * ignora `2-digit` para `es-AR` ("6/10") mientras otras lo respetan. El
 * backend corre en Windows en desarrollo y en Linux en Docker y en Render: la
 * misma respuesta no puede depender de dónde corrió.
 */
function fechaCorta(fecha) {
  const partes = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).formatToParts(new Date(fecha));

  const valor = (tipo) =>
    partes.find((parte) => parte.type === tipo).value.padStart(2, "0");

  return `${valor("day")}/${valor("month")}`;
}

/* ---------------------------------------------------------------------------
 * Respuesta por intención
 * ------------------------------------------------------------------------- */

async function responderReponer(comercioId) {
  const productos = await productosParaReponer(comercioId, { limite: 50 });

  if (productos.length === 0) {
    return "No tenés productos por debajo del stock mínimo.";
  }

  const titulo =
    productos.length === 1
      ? "Tenés 1 producto para reponer:"
      : `Tenés ${productos.length} productos para reponer:`;

  const lineas = productos.map(
    (p) =>
      `${p.nombre}: ${queda(p.enStock, p.unidadMedida)}, el mínimo es ${p.umbralMinimo}`,
  );

  return `${titulo}\n${listar(lineas, "Los ves todos en Productos.")}`;
}

async function responderResumen(comercioId, { dias }) {
  const { porTipo } = await resumenDeActividad(comercioId, { dias });

  if (porTipo.length === 0) {
    return `No hubo movimientos en ${periodo(dias)}.`;
  }

  const total = porTipo.reduce((suma, fila) => suma + fila.movimientos, 0);
  const lineas = porTipo.map(
    (fila) =>
      `${fila.movimientos} ${fila.movimientos === 1 ? fila.tipo : PLURAL_DE_TIPO[fila.tipo] ?? fila.tipo}`,
  );

  return `En ${periodo(dias)} hubo ${total} ${total === 1 ? "movimiento" : "movimientos"}:\n${listar(lineas, "")}`;
}

async function responderMovimientos(comercioId, { dias, tipo }) {
  const { movimientos } = await movimientosRecientes(comercioId, {
    dias,
    tipo,
    limite: 50,
  });

  const nombre = tipo ? PLURAL_DE_TIPO[tipo] : "movimientos";
  // "Últimas ventas" pero "últimos ajustes": el título concuerda con el tipo.
  const ultimos = FEMENINOS.has(tipo) ? "Últimas" : "Últimos";

  if (movimientos.length === 0) {
    return `No hubo ${nombre} en ${periodo(dias)}.`;
  }

  const lineas = movimientos.map(
    (m) =>
      `${fechaCorta(m.fecha)}: ${m.tipo} de ${conUnidad(Math.abs(m.cantidad), m.unidadMedida)} de ${m.producto}`,
  );

  return `${ultimos} ${nombre} (${periodo(dias)}):\n${listar(lineas, "Los ves todos en Movimientos.")}`;
}

/**
 * Variantes a probar, de la más fiel a la más laxa: la frase entera, sin el
 * plural, y la primera palabra sola. "Cocas" no encuentra "Coca-Cola", pero
 * "coca" sí; y "coca cola" tampoco, por el guion, pero "coca" otra vez sí.
 */
function variantesDeBusqueda(busqueda) {
  const sinPlural = busqueda.replace(/(es|s)$/, "");
  const primera = busqueda.split(" ")[0].replace(/(es|s)$/, "");
  return [...new Set([busqueda, sinPlural, primera])].filter(
    (variante) => variante.length >= 2,
  );
}

async function responderStock(comercioId, { busqueda }) {
  if (!busqueda) {
    return "¿De qué producto? Decime el nombre, por ejemplo: «¿cuánta yerba me queda?».";
  }

  let encontrados = [];
  for (const variante of variantesDeBusqueda(busqueda)) {
    encontrados = await stockDeProducto(comercioId, { busqueda: variante });
    if (encontrados.length > 0) break;
  }

  if (encontrados.length === 0) {
    return `No encontré ningún producto que se llame «${busqueda}».`;
  }

  if (encontrados.length > 1) {
    const lineas = encontrados.map(
      (p) => `${p.nombre}: ${conUnidad(p.enStock, p.unidadMedida)}`,
    );
    return `Encontré ${encontrados.length} productos:\n${listar(lineas, "")}`;
  }

  const [p] = encontrados;
  let texto = `De ${p.nombre} te ${queda(p.enStock, p.unidadMedida)}`;

  if (p.porUbicacion.length > 1) {
    const detalle = p.porUbicacion
      .map(({ ubicacion, cantidad }) => `${ubicacion}: ${cantidad}`)
      .join(", ");
    texto += ` (${detalle})`;
  }

  texto += ".";

  if (p.porDebajoDelUmbral) {
    texto += ` Está en el mínimo o por debajo (el mínimo es ${p.umbralMinimo}).`;
  }

  return texto;
}

/**
 * Responde una pregunta por reglas. Firma fija:
 * `(comercioId, pregunta) -> Promise<string>`, y nunca tira.
 */
export async function responderPorReglas(comercioId, pregunta) {
  try {
    const { intencion, ...parametros } = detectarIntencion(pregunta);

    switch (intencion) {
      case "reponer":
        return await responderReponer(comercioId);
      case "resumen":
        return await responderResumen(comercioId, parametros);
      case "movimientos":
        return await responderMovimientos(comercioId, parametros);
      case "sinDatos":
        return MENSAJE_SIN_DATOS;
      case "stock":
        return await responderStock(comercioId, parametros);
      default:
        return MENSAJE_AYUDA;
    }
  } catch (error) {
    // Se loguea entero: sin esto, una base caída en modo degradado se vería
    // igual que una pregunta que no se entendió, y no habría con qué
    // diagnosticarlo.
    console.error("[asistente] las reglas del modo limitado fallaron:", error);
    return MENSAJE_GENERICO;
  }
}
