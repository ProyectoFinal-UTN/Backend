import * as asistenteService from "../services/asistente.service.js";

/**
 * Controller del Asistente Inteligente (HU-26).
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
