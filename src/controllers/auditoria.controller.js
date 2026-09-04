import {
  listarEventos,
  opcionesDeFiltro,
} from "../services/auditoria.service.js";

/**
 * Controllers del registro de auditoria (HU-5).
 *
 * Solo traducen HTTP. El `comercioId` sale de `req`, donde lo dejo
 * `requireAuth` a partir de la sesion.
 */

export async function listar(req, res, next) {
  try {
    const [eventos, filtros] = await Promise.all([
      listarEventos(req.comercioId, {
        accion: req.query.accion,
        recurso: req.query.recurso,
        limite: req.query.limite,
      }),
      opcionesDeFiltro(req.comercioId),
    ]);

    res.json({ eventos, filtros });
  } catch (error) {
    next(error);
  }
}
