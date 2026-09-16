import {
  darDeBajaCuenta,
  exportarDatos,
} from "../services/datosPersonales.service.js";

/**
 * Controllers de los derechos sobre datos personales (HU-31, Ley 25.326).
 *
 * A diferencia del resto, estos no dependen del comercio sino de la persona:
 * el `userId` sale de la sesion y cada uno solo puede pedir lo suyo.
 */

export async function misDatos(req, res, next) {
  try {
    const datos = await exportarDatos(req.usuario.id);

    // Se ofrece como descarga: el derecho de acceso es "llevarse sus datos",
    // no "verlos en pantalla".
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="mis-datos.json"',
    );
    res.json(datos);
  } catch (error) {
    next(error);
  }
}

export async function darDeBaja(req, res, next) {
  try {
    await darDeBajaCuenta(req.usuario.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
