import * as kpisService from "../services/kpis.service.js";

/**
 * Controller del dashboard de KPIs (HU-22).
 *
 * Solo traduce HTTP: lee `req`, llama al service y arma la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` sale de `req`, donde
 * lo deja `requireAuth` a partir de la sesion.
 */

export async function obtener(req, res, next) {
  try {
    res.json(await kpisService.obtenerKpis(req.comercioId, req.query));
  } catch (error) {
    next(error);
  }
}
