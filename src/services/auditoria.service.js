import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditoria, comercio, member } from "../db/schema.js";
import { ErrorDeNegocio } from "../lib/errores.js";

/**
 * Registro de accesos y acciones (HU-5).
 *
 * Es un libro append-only: solo se insertan filas y se leen. No hay forma de
 * editar ni borrar un evento desde la aplicacion, que es lo unico que hace util
 * a una auditoria.
 */

/** Cuantos eventos devuelve como maximo una consulta. */
const LIMITE_POR_DEFECTO = 100;
const LIMITE_MAXIMO = 500;

/**
 * Deja constancia de un hecho.
 *
 * Nunca lanza: si la auditoria falla, la operacion que la origino ya ocurrio y
 * hacerla fallar por no poder registrarla seria peor. Se loguea y sigue.
 */
export async function registrarEvento({
  comercioId,
  usuarioId,
  usuarioCorreo,
  accion,
  recurso,
  recursoId,
  detalle,
  ip,
}) {
  if (!comercioId || !accion || !recurso) {
    return;
  }

  try {
    await db.insert(auditoria).values({
      comercioId,
      usuarioId: usuarioId ?? null,
      usuarioCorreo: usuarioCorreo ?? null,
      accion,
      recurso,
      recursoId: recursoId ? String(recursoId).slice(0, 100) : null,
      detalle: detalle ? String(detalle).slice(0, 255) : null,
      ip: ip ? String(ip).slice(0, 45) : null,
    });
  } catch (error) {
    console.error("[auditoria] no se pudo registrar el evento", error.message);
  }
}

/**
 * Registra un inicio de sesion.
 *
 * Va aparte porque el hook de Better Auth solo conoce al usuario, no el
 * comercio: hay que resolverlo desde su membresia. Si todavia no tiene ninguna
 * —el instante entre que nace el usuario y que se le crea el comercio— no hay
 * comercio al que atribuir el acceso, y el evento se omite en vez de inventarlo.
 */
export async function registrarAcceso({ userId, correo, ip }) {
  const [contexto] = await db
    .select({ comercioId: comercio.id })
    .from(member)
    .innerJoin(comercio, eq(comercio.organizationId, member.organizationId))
    .where(eq(member.userId, userId))
    .limit(1);

  if (!contexto) {
    return;
  }

  await registrarEvento({
    comercioId: contexto.comercioId,
    usuarioId: userId,
    usuarioCorreo: correo,
    accion: "inicio_sesion",
    recurso: "sesion",
    ip,
  });
}

/**
 * Devuelve los eventos del comercio, del mas nuevo al mas viejo.
 *
 * Acepta filtros opcionales por accion y por recurso, que es como se busca en
 * la practica: "que se borro" o "quien entro".
 */
export async function listarEventos(comercioId, { accion, recurso, limite } = {}) {
  const cantidad = Math.min(
    Number.parseInt(limite, 10) || LIMITE_POR_DEFECTO,
    LIMITE_MAXIMO,
  );

  const condiciones = [eq(auditoria.comercioId, comercioId)];

  if (accion) {
    condiciones.push(eq(auditoria.accion, accion));
  }

  if (recurso) {
    condiciones.push(eq(auditoria.recurso, recurso));
  }

  return db
    .select({
      id: auditoria.id,
      usuarioCorreo: auditoria.usuarioCorreo,
      accion: auditoria.accion,
      recurso: auditoria.recurso,
      recursoId: auditoria.recursoId,
      detalle: auditoria.detalle,
      ip: auditoria.ip,
      fecha: auditoria.createdAt,
    })
    .from(auditoria)
    .where(and(...condiciones))
    .orderBy(desc(auditoria.createdAt))
    .limit(cantidad);
}

/** Las acciones y recursos que hay registrados, para armar los filtros. */
export async function opcionesDeFiltro(comercioId) {
  const filas = await db
    .selectDistinct({ accion: auditoria.accion, recurso: auditoria.recurso })
    .from(auditoria)
    .where(eq(auditoria.comercioId, comercioId));

  return {
    acciones: [...new Set(filas.map((f) => f.accion))].sort(),
    recursos: [...new Set(filas.map((f) => f.recurso))].sort(),
  };
}

/** Para que el controller no invente un 404 propio. */
export function exigirComercio(comercioId) {
  if (!comercioId) {
    throw new ErrorDeNegocio("El comercio no existe", 404);
  }
}
