import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comercio, ubicacion } from "../db/schema.js";

/**
 * Logica de negocio de las ubicaciones de stock (HU-8).
 *
 * Toda funcion recibe `comercioId` como primer dato y lo usa en el WHERE. Ese
 * valor sale siempre de la sesion (lo pone `requireAuth`), nunca del body ni
 * de la query string: si el cliente pudiera elegirlo, podria leer o pisar el
 * stock de otro comercio.
 */

/** Error de negocio con el status HTTP que le corresponde. */
class ErrorDeNegocio extends Error {
  constructor(mensaje, status) {
    super(mensaje);
    this.status = status;
  }
}

function normalizarNombre(nombre) {
  return typeof nombre === "string" ? nombre.trim() : "";
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
  const nombre = normalizarNombre(nombreCrudo);

  if (!nombre) {
    throw new ErrorDeNegocio("El nombre de la ubicación es obligatorio", 400);
  }

  if (nombre.length > 100) {
    throw new ErrorDeNegocio(
      "El nombre de la ubicación no puede superar los 100 caracteres",
      400,
    );
  }

  const [existente] = await db
    .select({ id: ubicacion.id })
    .from(ubicacion)
    .where(
      and(eq(ubicacion.comercioId, comercioId), eq(ubicacion.nombre, nombre)),
    )
    .limit(1);

  if (existente) {
    throw new ErrorDeNegocio(`Ya existe una ubicación llamada "${nombre}"`, 409);
  }

  const [creada] = await db
    .insert(ubicacion)
    .values({ comercioId, nombre })
    .returning({
      id: ubicacion.id,
      nombre: ubicacion.nombre,
      createdAt: ubicacion.createdAt,
    });

  return creada;
}

export async function renombrarUbicacion(comercioId, id, nombreCrudo) {
  const nombre = normalizarNombre(nombreCrudo);

  if (!nombre) {
    throw new ErrorDeNegocio("El nombre de la ubicación es obligatorio", 400);
  }

  const [duplicada] = await db
    .select({ id: ubicacion.id })
    .from(ubicacion)
    .where(
      and(eq(ubicacion.comercioId, comercioId), eq(ubicacion.nombre, nombre)),
    )
    .limit(1);

  if (duplicada && duplicada.id !== id) {
    throw new ErrorDeNegocio(`Ya existe una ubicación llamada "${nombre}"`, 409);
  }

  const [actualizada] = await db
    .update(ubicacion)
    .set({ nombre })
    .where(and(eq(ubicacion.id, id), eq(ubicacion.comercioId, comercioId)))
    .returning({ id: ubicacion.id, nombre: ubicacion.nombre });

  if (!actualizada) {
    throw new ErrorDeNegocio("La ubicación no existe", 404);
  }

  return actualizada;
}

/**
 * Elimina una ubicacion.
 *
 * Cuando existan `stock` y `movimiento` (HU-13) hay que impedir el borrado si
 * la ubicacion tiene movimientos: el libro es append-only y borrar su ubicacion
 * dejaria el historial sin referencia. Hoy no hay nada que la referencie.
 */
export async function eliminarUbicacion(comercioId, id) {
  const [eliminada] = await db
    .delete(ubicacion)
    .where(and(eq(ubicacion.id, id), eq(ubicacion.comercioId, comercioId)))
    .returning({ id: ubicacion.id });

  if (!eliminada) {
    throw new ErrorDeNegocio("La ubicación no existe", 404);
  }

  return eliminada;
}

/** Devuelve los parametros generales del negocio (HU-8). */
export async function obtenerConfiguracion(comercioId) {
  const [fila] = await db
    .select({ moneda: comercio.moneda, nombre: comercio.nombre })
    .from(comercio)
    .where(eq(comercio.id, comercioId))
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("El comercio no existe", 404);
  }

  const ubicaciones = await listarUbicaciones(comercioId);

  return { ...fila, ubicaciones };
}

/** Codigos ISO 4217 que el sistema acepta hoy. */
export const MONEDAS_VALIDAS = ["ARS", "USD", "EUR", "BRL", "CLP", "UYU"];

export async function actualizarMoneda(comercioId, monedaCruda) {
  const moneda =
    typeof monedaCruda === "string" ? monedaCruda.trim().toUpperCase() : "";

  if (!MONEDAS_VALIDAS.includes(moneda)) {
    throw new ErrorDeNegocio(
      `Moneda inválida. Las aceptadas son: ${MONEDAS_VALIDAS.join(", ")}`,
      400,
    );
  }

  const [actualizado] = await db
    .update(comercio)
    .set({ moneda })
    .where(eq(comercio.id, comercioId))
    .returning({ moneda: comercio.moneda });

  if (!actualizado) {
    throw new ErrorDeNegocio("El comercio no existe", 404);
  }

  return actualizado;
}
