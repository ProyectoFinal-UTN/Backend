import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comercio, member, organization } from "../db/schema.js";
import { ROLES } from "../lib/permissions.js";

/** Nombre con el que nace el comercio hasta que HU-6 carga el perfil real. */
export const NOMBRE_COMERCIO_POR_DEFECTO = "Mi comercio";

/**
 * Convierte un texto en un slug apto para `organization.slug`.
 * Sin tildes, sin espacios, solo minusculas, numeros y guiones.
 */
export function generarSlug(texto) {
  const base = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  // El sufijo evita colisiones entre dos comercios con el mismo nombre:
  // `organization.slug` es unique y un choque abortaria el registro.
  return `${base || "comercio"}-${randomUUID().slice(0, 8)}`;
}

/**
 * Da de alta el comercio de un usuario recien registrado (HU-1).
 *
 * Crea las tres filas que convierten a un usuario suelto en propietario de un
 * comercio, dentro de una unica transaccion:
 *
 *   organization  ->  el tenant que gestiona Better Auth
 *   member        ->  la membresia, con rol `propietario` (RF9)
 *   comercio      ->  los datos del negocio, 1:1 con organization
 *
 * Va en transaccion porque las tres son inseparables: un usuario con
 * organization pero sin comercio no pasa `requireAuth`, y uno sin member no
 * tiene rol. Si falla cualquiera, no queda ninguna a medias.
 *
 * El nombre del comercio queda en un placeholder a proposito: el formulario de
 * registro solo pide correo y contrasena, y el perfil real se carga en HU-6.
 */
export async function crearComercioParaPropietario({ userId, email }) {
  const nombreOrganizacion = email?.split("@")[0] || "comercio";

  return db.transaction(async (tx) => {
    const organizationId = randomUUID();
    const ahora = new Date();

    await tx.insert(organization).values({
      id: organizationId,
      name: nombreOrganizacion,
      slug: generarSlug(nombreOrganizacion),
      createdAt: ahora,
    });

    await tx.insert(member).values({
      id: randomUUID(),
      organizationId,
      userId,
      role: ROLES.PROPIETARIO,
      createdAt: ahora,
    });

    const [comercioCreado] = await tx
      .insert(comercio)
      .values({
        organizationId,
        nombre: NOMBRE_COMERCIO_POR_DEFECTO,
      })
      .returning({ id: comercio.id });

    return { organizationId, comercioId: comercioCreado.id };
  });
}

/**
 * Devuelve el comercio de una organizacion, o null si no existe.
 * Lo usa HU-6 para saber si hay que crear o actualizar el perfil.
 */
export async function obtenerComercioPorOrganizacion(organizationId) {
  const [fila] = await db
    .select()
    .from(comercio)
    .where(eq(comercio.organizationId, organizationId))
    .limit(1);

  return fila ?? null;
}
