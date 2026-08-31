import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { ubicacion } from "../db/schema.js";
import {
  ErrorDeNegocio,
  PG_UNIQUE_VIOLATION,
  esUuid,
} from "../lib/errores.js";

/**
 * Logica de negocio de las ubicaciones de stock (HU-8).
 *
 * Toda funcion recibe `comercioId` y lo usa en el WHERE. Ese valor sale
 * siempre de la sesion (lo pone `requireAuth`), nunca del body ni de la query
 * string: si el cliente pudiera elegirlo, podria leer o pisar el stock de otro
 * comercio.
 */

const LARGO_MAXIMO_NOMBRE = 100;

/**
 * Valida y normaliza el nombre de una ubicacion.
 * Se usa tanto al crear como al renombrar, para que las dos rutas devuelvan
 * los mismos codigos ante los mismos datos.
 */
function validarNombre(nombreCrudo) {
  const nombre = typeof nombreCrudo === "string" ? nombreCrudo.trim() : "";

  if (!nombre) {
    throw new ErrorDeNegocio("El nombre de la ubicación es obligatorio", 400);
  }

  if (nombre.length > LARGO_MAXIMO_NOMBRE) {
    throw new ErrorDeNegocio(
      `El nombre de la ubicación no puede superar los ${LARGO_MAXIMO_NOMBRE} caracteres`,
      400,
    );
  }

  return nombre;
}

/**
 * Un id que no tiene forma de UUID no puede existir en la tabla, y mandarlo a
 * la query haria que Postgres tire 22P02 y el error salga como 500. Se corta
 * antes con el 404 que corresponde.
 */
function exigirIdValido(id) {
  if (!esUuid(id)) {
    throw new ErrorDeNegocio("La ubicación no existe", 404);
  }

  return id;
}

/**
 * Convierte el choque contra `ubicacion_comercioId_nombre_uidx` en el 409 que
 * corresponde.
 *
 * El chequeo previo de duplicados no alcanza: entre el SELECT y el INSERT hay
 * una ventana, y dos pedidos simultaneos (o un doble click) la atraviesan. La
 * base es la que decide de verdad, asi que se traduce su error.
 */
function traducirDuplicado(error, nombre) {
  if (error?.cause?.code === PG_UNIQUE_VIOLATION || error?.code === PG_UNIQUE_VIOLATION) {
    return new ErrorDeNegocio(`Ya existe una ubicación llamada "${nombre}"`, 409);
  }

  return error;
}

export async function listarUbicaciones(comercioId) {
  return db
    .select({
      id: ubicacion.id,
      nombre: ubicacion.nombre,
      createdAt: ubicacion.createdAt,
    })
    .from(ubicacion)
    .where(eq(ubicacion.comercioId, comercioId))
    .orderBy(asc(ubicacion.nombre));
}

export async function crearUbicacion(comercioId, nombreCrudo) {
  const nombre = validarNombre(nombreCrudo);

  try {
    const [creada] = await db
      .insert(ubicacion)
      .values({ comercioId, nombre })
      .returning({
        id: ubicacion.id,
        nombre: ubicacion.nombre,
        createdAt: ubicacion.createdAt,
      });

    return creada;
  } catch (error) {
    throw traducirDuplicado(error, nombre);
  }
}

export async function renombrarUbicacion(comercioId, idCrudo, nombreCrudo) {
  const id = exigirIdValido(idCrudo);
  const nombre = validarNombre(nombreCrudo);

  try {
    const [actualizada] = await db
      .update(ubicacion)
      .set({ nombre })
      .where(and(eq(ubicacion.id, id), eq(ubicacion.comercioId, comercioId)))
      .returning({ id: ubicacion.id, nombre: ubicacion.nombre });

    if (!actualizada) {
      // 404 y no 403 a proposito: para este comercio esa fila no existe, y
      // decirle "existe pero no es tuya" filtraria informacion de otro.
      throw new ErrorDeNegocio("La ubicación no existe", 404);
    }

    return actualizada;
  } catch (error) {
    throw traducirDuplicado(error, nombre);
  }
}

/**
 * Elimina una ubicacion.
 *
 * Cuando existan `stock` y `movimiento` (HU-13) hay que impedir el borrado si
 * la ubicacion tiene movimientos: el libro es append-only y borrar su ubicacion
 * dejaria el historial sin referencia. Hoy no hay nada que la referencie.
 */
export async function eliminarUbicacion(comercioId, idCrudo) {
  const id = exigirIdValido(idCrudo);

  const [eliminada] = await db
    .delete(ubicacion)
    .where(and(eq(ubicacion.id, id), eq(ubicacion.comercioId, comercioId)))
    .returning({ id: ubicacion.id });

  if (!eliminada) {
    throw new ErrorDeNegocio("La ubicación no existe", 404);
  }

  return eliminada;
}
