import * as movimientosService from "../services/movimientos.service.js";

/**
 * Controllers del registro de movimientos de stock (HU-13).
 *
 * Solo traducen HTTP: leen `req`, llaman al service y arman la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` y el `usuarioId` salen
 * de `req`, donde los deja `requireAuth` a partir de la sesion, nunca del body.
 */

export async function registrar(req, res, next) {
  try {
    const registrado = await movimientosService.registrarMovimiento(
      req.comercioId,
      req.usuario.id,
      req.body,
    );
    res.status(201).json(registrado);
  } catch (error) {
    next(error);
  }
}
