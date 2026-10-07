import * as recomendacionesService from "../services/asistente.recomendaciones.service.js";
import * as asistenteService from "../services/asistente.service.js";

/**
 * Controller del Asistente Inteligente (HU-26, HU-27).
 *
 * Solo traduce HTTP: lee `req`, llama al service y arma la respuesta. El
 * `comercioId` sale de `req`, donde lo dejo `requireAuth` a partir de la
 * sesion, nunca del body: la pregunta la escribe el usuario, el comercio sobre
 * el que se contesta lo decide el servidor.
 *
 * Siempre 200 cuando la pregunta es valida, incluso si el proveedor de LLM esta
 * caido. Que la respuesta venga del modelo o de las reglas de HU-28 no es un
 * error del pedido: viaja en el campo `modo` del cuerpo, no en el status.
 */

export async function consultar(req, res, next) {
  try {
    const respuesta = await asistenteService.responder(
      req.comercioId,
      req.body,
    );
    res.status(200).json(respuesta);
  } catch (error) {
    next(error);
  }
}

/**
 * Recomendaciones proactivas (HU-27).
 *
 * `dias` llega como string del query y el service lo acota: un valor raro no es
 * un 400 sino la ventana por defecto, porque es un parametro de afinado que
 * manda la pantalla y no un dato que escribio la persona.
 */
export async function recomendaciones(req, res, next) {
  try {
    const resultado = await recomendacionesService.recomendar(req.comercioId, {
      dias: req.query.dias,
    });
    res.status(200).json(resultado);
  } catch (error) {
    next(error);
  }
}
