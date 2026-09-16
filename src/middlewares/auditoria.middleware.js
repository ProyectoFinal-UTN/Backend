import { registrarEvento } from "../services/auditoria.service.js";

/**
 * Deja constancia de toda operacion que cambie datos (HU-5).
 *
 * Va montado una sola vez en `app.js`, antes de las rutas de negocio, en vez de
 * llamarse desde cada service. Dos razones:
 *
 * - Cubre tambien los endpoints de los demas integrantes sin tocarles el
 *   codigo, y sigue cubriendo los que se agreguen despues.
 * - No se puede olvidar. Un `registrarEvento` suelto dentro de cada service se
 *   omite el dia que alguien agrega una ruta con apuro, y una auditoria con
 *   agujeros es peor que no tenerla, porque da una falsa sensacion de control.
 *
 * Solo registra lo que efectivamente cambio algo: los GET no dejan rastro y los
 * intentos rechazados tampoco, porque no modificaron nada. Un 403 no es un
 * hecho auditable del negocio; es el sistema funcionando.
 */

const ACCIONES = {
  POST: "crear",
  PUT: "editar",
  PATCH: "editar",
  DELETE: "eliminar",
};

/**
 * Deduce que recurso se toco a partir de la URL.
 *
 * `/api/productos/abc-123` -> { recurso: "producto", recursoId: "abc-123" }
 *
 * Se usa el singular porque asi estan nombradas las entidades en el DER, y se
 * descartan los segmentos que son ids para no confundirlos con el recurso.
 */
export function interpretarRuta(url) {
  const camino = url.split("?")[0];
  const partes = camino.split("/").filter(Boolean);

  // Se saca el "api" del principio.
  if (partes[0] === "api") {
    partes.shift();
  }

  if (partes.length === 0) {
    return null;
  }

  const enSingular = (palabra) =>
    palabra.endsWith("es") ? palabra.slice(0, -2) : palabra.replace(/s$/, "");

  const recurso = enSingular(partes[0]);

  // El id es el primer segmento que sigue, salvo que sea una subruta con
  // nombre (`/miembros/invitaciones`, `/miembros/xxx/rol`).
  const segundo = partes[1];
  const pareceId = segundo && /[0-9a-f-]{8,}/i.test(segundo);

  return {
    recurso,
    recursoId: pareceId ? segundo : null,
    // La subruta aclara qué se hizo cuando la URL tiene más de un nivel.
    detalle: partes.length > 1 && !pareceId ? partes.slice(1).join("/") : null,
  };
}

export function auditarCambios(req, res, next) {
  const accion = ACCIONES[req.method];

  if (!accion) {
    return next();
  }

  // Se engancha al final de la respuesta para conocer el resultado: recien ahi
  // se sabe si la operacion prospero.
  res.on("finish", () => {
    if (res.statusCode >= 400) {
      return;
    }

    // `requireAuth` deja estos datos en `req`. Sin comercio no hay a quien
    // atribuir el hecho, asi que no se registra.
    if (!req.comercioId) {
      return;
    }

    const ruta = interpretarRuta(req.originalUrl);

    if (!ruta) {
      return;
    }

    registrarEvento({
      comercioId: req.comercioId,
      usuarioId: req.usuario?.id,
      usuarioCorreo: req.usuario?.email,
      accion,
      recurso: ruta.recurso,
      recursoId: ruta.recursoId,
      detalle: ruta.detalle,
      ip: req.ip,
    });
  });

  return next();
}
