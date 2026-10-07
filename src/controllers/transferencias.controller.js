import * as transferenciasService from "../services/transferencias.service.js";

/**
 * Controllers de la transferencia de stock entre ubicaciones (HU-12).
 *
 * Solo traducen HTTP: leen `req`, llaman al service y arman la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` y el `usuarioId` salen
 * de `req`, donde los deja `requireAuth` a partir de la sesion, nunca del body.
 */

export async function transferir(req, res, next) {
  try {
    const transferida = await transferenciasService.transferirStock(
      req.comercioId,
      req.usuario.id,
      req.body,
    );
    res.status(201).json(transferida);
  } catch (error) {
    next(error);
  }
}
