import * as productoProveedorService from "../services/productoProveedor.service.js";

/**
 * Controllers de la asociacion producto-proveedor (HU-20). Solo traducen HTTP;
 * el `comercioId` sale de `req`, donde lo deja `requireAuth`.
 */

export async function listarProveedoresDeProducto(req, res, next) {
  try {
    res.json(
      await productoProveedorService.listarProveedoresDeProducto(
        req.comercioId,
        req.params.id,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function listarProductosDeProveedor(req, res, next) {
  try {
    res.json(
      await productoProveedorService.listarProductosDeProveedor(
        req.comercioId,
        req.params.id,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function asociar(req, res, next) {
  try {
    const vinculo = await productoProveedorService.asociarProveedor(
      req.comercioId,
      req.params.id,
      req.body,
    );
    res.status(201).json(vinculo);
  } catch (error) {
    next(error);
  }
}

export async function desasociar(req, res, next) {
  try {
    await productoProveedorService.desasociarProveedor(
      req.comercioId,
      req.params.id,
      req.params.proveedorId,
    );
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
