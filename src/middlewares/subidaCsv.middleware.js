import multer from "multer";
import { ErrorDeNegocio } from "../lib/errores.js";

/**
 * Recepcion del archivo CSV de la importacion de catalogo (HU-7).
 *
 * Express no parsea `multipart/form-data` por si solo, asi que el archivo entra
 * por multer y queda en `req.file.buffer`.
 *
 * En memoria y no en disco a proposito: el filesystem de Render es efimero
 * (cada deploy lo borra) y un catalogo de hasta 2 MB no justifica escribir un
 * temporal que despues hay que acordarse de limpiar.
 */

const TAMANO_MAXIMO_MB = 2;
const TAMANO_MAXIMO_BYTES = TAMANO_MAXIMO_MB * 1024 * 1024;

/**
 * El navegador no se pone de acuerdo con el tipo de un .csv: Chrome en Windows
 * suele mandar `application/vnd.ms-excel` (porque Excel se registro como el
 * programa que abre esa extension) y a veces `application/octet-stream`. Por
 * eso la extension manda y el mimetype es solo la alternativa, no un filtro
 * duro: rechazar por mimetype dejaria afuera archivos perfectamente validos.
 */
const TIPOS_ACEPTADOS = [
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/octet-stream",
];

const subida = multer({
  storage: multer.memoryStorage(),
  // `fields` y `parts` tambien tienen que estar acotados, no solo el tamaño del
  // archivo: por defecto son infinitos, y como el storage es en memoria, un
  // usuario con sesion puede tumbar la instancia mandando miles de campos de
  // texto al lado de un CSV chiquito, sin pasarse nunca del limite de 2 MB por
  // archivo. `fields: 0` porque este endpoint no espera ningun campo ademas
  // del archivo; `parts: 2` deja el archivo y un poco de aire.
  limits: {
    fileSize: TAMANO_MAXIMO_BYTES,
    files: 1,
    fields: 0,
    parts: 2,
  },
  fileFilter(req, archivo, cb) {
    const esCsvPorExtension = /\.csv$/i.test(archivo.originalname ?? "");

    if (!esCsvPorExtension && !TIPOS_ACEPTADOS.includes(archivo.mimetype)) {
      return cb(new ErrorDeNegocio("El archivo debe ser un CSV", 400));
    }

    return cb(null, true);
  },
});

/**
 * Envuelve `multer.single` para traducir sus errores a `ErrorDeNegocio`.
 *
 * Sin esto, un archivo de 5 MB llega al manejador de errores de `app.js` como
 * un `MulterError` sin `status` y sale como 500 "Error interno del servidor":
 * el usuario no se entera de que lo unico que pasa es que su archivo es
 * demasiado grande.
 */
export function recibirCsv(req, res, next) {
  subida.single("archivo")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      const mensajes = {
        LIMIT_FILE_SIZE: `El archivo supera el máximo de ${TAMANO_MAXIMO_MB} MB`,
        LIMIT_FILE_COUNT: "Se puede importar un solo archivo por vez",
        LIMIT_UNEXPECTED_FILE:
          'El archivo debe enviarse en el campo "archivo"',
        LIMIT_FIELD_COUNT: "Solo se espera el archivo, sin campos adicionales",
        LIMIT_PART_COUNT: "Solo se espera el archivo, sin campos adicionales",
      };

      return next(
        new ErrorDeNegocio(
          mensajes[error.code] ?? "No se pudo leer el archivo enviado",
          400,
        ),
      );
    }

    return next(error);
  });
}
