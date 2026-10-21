import * as proveedoresService from "../services/proveedores.service.js";

/**
 * Controllers del directorio de proveedores (HU-19).
 *
 * Solo traducen HTTP: leen `req`, llaman al service y arman la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` sale de `req`, donde
 * lo deja `requireAuth` a partir de la sesion.
 */

export async function listar(req, res, next) {
  try {
    res.json(await proveedoresService.listarProveedores(req.comercioId));
  } catch (error) {
    next(error);
  }
}

export async function obtener(req, res, next) {
  try {
    res.json(
      await proveedoresService.obtenerProveedor(req.comercioId, req.params.id),
    );
  } catch (error) {
    next(error);
  }
}

export async function crear(req, res, next) {
  try {
    const creado = await proveedoresService.crearProveedor(
      req.comercioId,
      req.body,
    );
    res.status(201).json(creado);
  } catch (error) {
    next(error);
  }
}

export async function actualizar(req, res, next) {
  try {
    res.json(
      await proveedoresService.actualizarProveedor(
        req.comercioId,
        req.params.id,
        req.body,
      ),
    );
  } catch (error) {
    next(error);
  }
}

export async function eliminar(req, res, next) {
  try {
    await proveedoresService.eliminarProveedor(req.comercioId, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
