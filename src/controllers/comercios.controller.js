import {
  actualizarPerfil,
  obtenerPerfil,
} from "../services/comercios.service.js";

/**
 * Controllers del perfil del comercio (HU-6).
 *
 * Solo traducen HTTP. El `comercioId` sale de `req`, donde lo dejo
 * `requireAuth` a partir de la sesion, nunca del body ni de la query string.
 */

export async function ver(req, res, next) {
  try {
    res.json(await obtenerPerfil(req.comercioId));
  } catch (error) {
    next(error);
  }
}

export async function guardar(req, res, next) {
  try {
    res.json(await actualizarPerfil(req.comercioId, req.body));
  } catch (error) {
    next(error);
  }
}
