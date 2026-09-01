import * as productosService from "../services/productos.service.js";

/**
 * Controllers del catalogo de productos (HU-9).
 *
 * Solo traducen HTTP: leen `req`, llaman al service y arman la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` sale de `req`, donde
 * lo deja `requireAuth` a partir de la sesion.
 */

export async function listar(req, res, next) {
  try {
    res.json(await productosService.listarProductos(req.comercioId));
  } catch (error) {
    next(error);
  }
}

export async function obtener(req, res, next) {
  try {
    res.json(
      await productosService.obtenerProducto(req.comercioId, req.params.id),
    );
  } catch (error) {
    next(error);
  }
}

export async function crear(req, res, next) {
  try {
    const creado = await productosService.crearProducto(
      req.comercioId,
      req.usuario.id,
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
      await productosService.actualizarProducto(
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
    await productosService.eliminarProducto(req.comercioId, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function verificarCodigo(req, res, next) {
  try {
    res.json(
      await productosService.verificarCodigo(
        req.comercioId,
        req.params.codigoBarras,
      ),
    );
  } catch (error) {
    next(error);
  }
}