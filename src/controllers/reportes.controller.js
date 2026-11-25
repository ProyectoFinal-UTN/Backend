import * as reportesService from "../services/reportes.service.js";

/**
 * Controller de los reportes exportables (HU-25).
 *
 * Solo traduce HTTP: lee `req`, llama al service y arma la respuesta. Sin
 * logica de negocio y sin tocar la base. El `comercioId` sale de `req`, donde
 * lo deja `requireAuth` a partir de la sesion.
 */

export async function generarMovimientos(req, res, next) {
  try {
    const { nombreArchivo, contenido } =
      await reportesService.generarReporteMovimientos(
        req.comercioId,
        req.query,
      );

    // `attachment` arma el Content-Disposition con el nombre del archivo, que
    // es lo que hace que el navegador lo descargue en vez de abrirlo.
    res.attachment(nombreArchivo);
    res.type("application/pdf");
    // Son datos del comercio: que no queden guardados en ningun cache
    // intermedio ni en el del navegador.
    res.set("Cache-Control", "no-store");
    res.send(contenido);
  } catch (error) {
    next(error);
  }
}
