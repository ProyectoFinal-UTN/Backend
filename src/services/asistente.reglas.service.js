/**
 * Modo degradado del asistente (HU-28, SCRUM-119) — mitigacion del riesgo R2.
 *
 * Es la respuesta cuando el modelo de lenguaje no esta disponible: no hay key
 * configurada, el proveedor tardo mas que el timeout, o devolvio un error.
 * `asistente.service.js` ya detecta los tres casos y llama aca; lo que falta es
 * resolver la pregunta por reglas en vez de mandarla al modelo.
 *
 * ESTE ARCHIVO ES DE HU-28. Lo que hay hoy es el piso que HU-26 necesitaba para
 * no romper: contesta siempre lo mismo. La HU lo reemplaza por intents
 * predefinidos ("stock bajo", "resumen del dia") resueltos con las consultas de
 * `asistente.consultas.service.js`, que ya estan escritas y no dependen del
 * LLM: `productosParaReponer`, `stockDeProducto`, `movimientosRecientes` y
 * `resumenDeActividad`.
 *
 * Dos cosas que conviene no cambiar al completarlo:
 *
 * - La firma `(comercioId, pregunta) -> Promise<string>`. Quien llama ya le
 *   pone `modo: "limitado"` a lo que devuelvas, asi que alcanza con el texto.
 * - Que no tire excepciones. Esta funcion es el plan B; si tambien falla, el
 *   usuario se queda sin nada. Ante la duda, devolver el texto generico.
 *
 * El aviso de que la respuesta es limitada lo muestra el frontend a partir de
 * `modo`, asi que el texto de aca no necesita repetirlo.
 */
export async function responderPorReglas(comercioId, pregunta) {
  // `comercioId` y `pregunta` todavia no se usan: los va a usar HU-28 para
  // reconocer el intent y correr la consulta que corresponda.
  void comercioId;
  void pregunta;

  return "Por ahora no puedo analizar tu pregunta, pero el resto del sistema funciona normalmente. Podés ver el stock en Productos y lo que se movió en Movimientos.";
}
