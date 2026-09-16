import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comercio, member } from "../db/schema.js";
import { crearComercioParaPropietario } from "./comercios.service.js";

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
 */
async function buscarContexto({ userId, organizationId }) {
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

/**
 * Devuelve el comercio y el rol del usuario, reparando el alta si quedo a medias.
 *
 * El comercio lo crea un hook de Better Auth que corre despues de que la
 * transaccion del registro commitea. Si ese hook falla, el usuario queda
 * existiendo sin organizacion ni comercio, y sin esta reparacion recibiria 403
 * en todo endpoint de negocio para siempre, sin manera de arreglarlo.
 *
 * Por eso, antes de dar por perdido el contexto, se intenta crearlo una vez.
 * En el camino normal esta rama no se ejecuta nunca.
 *
 * @returns {Promise<{comercioId: string, rol: string, organizationId: string} | null>}
 *   null si no se pudo resolver ni reparar.
 */
export async function obtenerContextoDeComercio({
  userId,
  email,
  organizationId,
}) {
  const contexto = await buscarContexto({ userId, organizationId });

  if (contexto) {
    return contexto;
  }

  // Solo se repara si el usuario no tiene ninguna membresia. Si tiene una y
  // aun asi no hubo match, el problema es otro (por ejemplo una organizacion
  // activa ajena) y crear un comercio nuevo lo empeoraria.
  const membresias = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);

  if (membresias.length > 0) {
    return null;
  }

  console.warn(
    `[sesion] el usuario ${userId} no tenia comercio; se crea ahora para reparar un alta incompleta`,
  );

  await crearComercioParaPropietario({ userId, email });

  return buscarContexto({ userId, organizationId: null });
}
