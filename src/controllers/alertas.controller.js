import * as alertasService from "../services/alertasActivas.service.js";

/**
 * Controller del panel de alertas de reposicion (HU-17).
 *
 * Solo traduce HTTP: lee `req`, llama al service y arma la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` sale de `req`, donde
 * lo deja `requireAuth` a partir de la sesion.
 */

export async function listarActivas(req, res, next) {
  try {
    res.json(
      await alertasService.listarAlertasActivas(req.comercioId, req.query),
    );
  } catch (error) {
    next(error);
  }
}
