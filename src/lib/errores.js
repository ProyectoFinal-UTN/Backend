/**
 * Error de negocio con el status HTTP que le corresponde.
 *
 * Los services lo tiran y el manejador de errores de `app.js` lee `status`
 * para responder con el codigo correcto y el mensaje tal cual. Cualquier otro
 * error sin `status` se trata como 500, se loguea entero y al cliente le llega
 * un mensaje generico.
 */
export class ErrorDeNegocio extends Error {
  constructor(mensaje, status) {
    super(mensaje);
    this.name = "ErrorDeNegocio";
    this.status = status;
  }
}

/** Codigo de Postgres para violacion de constraint unique. */
export const PG_UNIQUE_VIOLATION = "23505";

/**
 * Codigos de Postgres para un DELETE que dejaria filas huerfanas.
 *
 * Son dos y hay que mirar los dos: `ON DELETE RESTRICT` chequea en el acto y
 * tira 23001 (restrict_violation), mientras que `NO ACTION` difiere el chequeo
 * al final de la sentencia y tira 23503 (foreign_key_violation). Mirar solo el
 * 23503 —el que uno espera— deja pasar el caso de RESTRICT como un 500.
 */
export const PG_RESTRICT_VIOLATION = "23001";
export const PG_FOREIGN_KEY_VIOLATION = "23503";

/** True si el error de la base es un borrado bloqueado por una FK. */
export function esBorradoBloqueadoPorFk(error) {
  const codigo = error?.cause?.code ?? error?.code;

  return (
    codigo === PG_RESTRICT_VIOLATION || codigo === PG_FOREIGN_KEY_VIOLATION
  );
}

/** Codigo de Postgres para texto que no parsea al tipo de la columna. */
export const PG_INVALID_TEXT_REPRESENTATION = "22P02";

/**
 * Formato de UUID tal como lo genera Postgres con `gen_random_uuid()`.
 *
 * Hace falta chequearlo antes de mandar un id a una query: si no es un UUID
 * valido, Postgres tira 22P02 y el error sale como 500 en vez del 404 que
 * corresponde a "ese recurso no existe".
 */
const FORMATO_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(valor) {
  return typeof valor === "string" && FORMATO_UUID.test(valor);
}
