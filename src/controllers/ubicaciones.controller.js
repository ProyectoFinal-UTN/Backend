import {
  actualizarMoneda,
  crearUbicacion,
  eliminarUbicacion,
  listarUbicaciones,
  obtenerConfiguracion,
  renombrarUbicacion,
} from "../services/ubicaciones.service.js";

/**
 * Controllers de la configuracion general del negocio (HU-8).
 *
 * Solo traducen HTTP: leen `req`, llaman al service y arman la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` sale de `req`, donde
 * lo dejo `requireAuth` a partir de la sesion.
 */

export async function listar(req, res, next) {
  try {
    res.json(await listarUbicaciones(req.comercioId));
  } catch (error) {
    next(error);
  }
}

export async function crear(req, res, next) {
  try {
    const creada = await crearUbicacion(req.comercioId, req.body?.nombre);
    res.status(201).json(creada);
  } catch (error) {
    next(error);
  }
}

export async function renombrar(req, res, next) {
  try {
    res.json(
      await renombrarUbicacion(req.comercioId, req.params.id, req.body?.nombre),
    );
  } catch (error) {
    next(error);
  }
}

export async function eliminar(req, res, next) {
  try {
    await eliminarUbicacion(req.comercioId, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function verConfiguracion(req, res, next) {
  try {
    res.json(await obtenerConfiguracion(req.comercioId));
  } catch (error) {
    next(error);
  }
}

export async function cambiarMoneda(req, res, next) {
  try {
    res.json(await actualizarMoneda(req.comercioId, req.body?.moneda));
  } catch (error) {
    next(error);
  }
}
