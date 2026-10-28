import * as pushService from "../services/push.service.js";

/**
 * Controllers de las notificaciones push (HU-18).
 *
 * Solo traducen HTTP: leen `req`, llaman al service y arman la respuesta. El
 * usuario y el comercio salen de `req`, donde los deja `requireAuth` a partir
 * de la sesion, nunca del body.
 */

export function obtenerClavePublica(req, res, next) {
  try {
    res.json(pushService.obtenerClavePublica());
  } catch (error) {
    next(error);
  }
}

export async function suscribir(req, res, next) {
  try {
    const guardada = await pushService.guardarSuscripcion(
      req.comercioId,
      req.usuario.id,
      req.body,
      req.get("user-agent"),
    );
    res.status(201).json(guardada);
  } catch (error) {
    next(error);
  }
}

export async function desuscribir(req, res, next) {
  try {
    await pushService.eliminarSuscripcion(req.usuario.id, req.body);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
