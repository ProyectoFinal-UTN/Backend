import {
  actualizarMoneda,
  obtenerConfiguracion,
} from "../services/configuracion.service.js";

/**
 * Controllers de los parametros generales del negocio (HU-8).
 *
 * Solo traducen HTTP. El `comercioId` sale de `req`, donde lo dejo
 * `requireAuth` a partir de la sesion, nunca del body ni de la query string.
 */

export async function ver(req, res, next) {
  try {
    res.json(await obtenerConfiguracion(req.comercioId));
  } catch (error) {
    next(error);
  }
}

export async function cambiarMoneda(req, res, next) {
  try {
    res.json(await actualizarMoneda(req.comercioId, req.body?.moneda));
  } catch (error) {
    next(error);
  }
}
