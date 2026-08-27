import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comercio, member } from "../db/schema.js";

/**
 * Resuelve el contexto de tenant de un usuario logueado.
 *
 * Better Auth guarda en la sesion el `activeOrganizationId`, pero las tablas de
 * negocio referencian `comercio.id`. Esta funcion traduce uno en el otro y de
 * paso trae el rol, que vive en MEMBER.
 *
 * Si la sesion todavia no tiene organizacion activa (por ejemplo, recien
 * despues del registro), cae en la unica membresia del usuario. Un comerciante
 * pertenece a un solo comercio, asi que el caso ambiguo no se da en la practica.
 *
 * @returns {Promise<{comercioId: string, rol: string, organizationId: string} | null>}
 *   null si el usuario no tiene comercio asociado.
 */
export async function obtenerContextoDeComercio({ userId, organizationId }) {
  const condicion = organizationId
    ? and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    : eq(member.userId, userId);

  const [fila] = await db
    .select({
      rol: member.role,
      organizationId: member.organizationId,
      comercioId: comercio.id,
    })
    .from(member)
    .innerJoin(comercio, eq(comercio.organizationId, member.organizationId))
    .where(condicion)
    .limit(1);

  return fila ?? null;
}
