import * as productosService from "../services/productos.service.js";
import * as importacionService from "../services/productosImportacion.service.js";

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

/**
 * Importacion masiva desde CSV (HU-7).
 *
 * Responde 200 aunque haya filas rechazadas: el archivo se proceso, y un
 * resultado parcial (algunas importadas, otras informadas con su motivo) es el
 * resultado esperado de la historia, no un error. Los 4xx quedan para lo que
 * invalida el archivo entero, y los tira el service.
 */
export async function importar(req, res, next) {
  try {
    res.json(
      await importacionService.importarProductos(
        req.comercioId,
        req.usuario.id,
        req.file?.buffer,
      ),
    );
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