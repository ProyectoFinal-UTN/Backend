import * as comprasService from "../services/comprasProveedor.service.js";

/**
 * Controller del historial de compras por proveedor (HU-21).
 *
 * Solo traduce HTTP: lee `req`, llama al service y arma la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` sale de `req`, donde
 * lo deja `requireAuth` a partir de la sesion.
 */

export async function listarHistorial(req, res, next) {
  try {
    res.json(
      await comprasService.historialDeCompras(
        req.comercioId,
        req.params.id,
        req.query,
      ),
    );
  } catch (error) {
    next(error);
  }
}
