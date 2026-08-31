import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comercio } from "../db/schema.js";
import { ErrorDeNegocio } from "../lib/errores.js";
import { listarUbicaciones } from "./ubicaciones.service.js";

/**
 * Parametros generales del negocio (HU-8).
 *
 * Los demas modulos leen la configuracion de un solo lugar, para que un cambio
 * de moneda o de ubicaciones se refleje en todos sin duplicar consultas.
 */

/** Codigos ISO 4217 que el sistema acepta hoy. */
export const MONEDAS_VALIDAS = ["ARS", "USD", "EUR", "BRL", "CLP", "UYU"];

export async function obtenerConfiguracion(comercioId) {
  const [datos] = await db
    .select({ nombre: comercio.nombre, moneda: comercio.moneda })
    .from(comercio)
    .where(eq(comercio.id, comercioId))
    .limit(1);

  if (!datos) {
    throw new ErrorDeNegocio("El comercio no existe", 404);
  }

  return { ...datos, ubicaciones: await listarUbicaciones(comercioId) };
}

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
