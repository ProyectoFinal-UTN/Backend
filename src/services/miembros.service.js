import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { invitation, member, user } from "../db/schema.js";
import { ErrorDeNegocio } from "../lib/errores.js";
import { ROLES, roles } from "../lib/permissions.js";

/**
 * Gestion del equipo del comercio (HU-4).
 *
 * Todo se resuelve sobre `organizationId`, que es el tenant que maneja Better
 * Auth, y sale siempre de la sesion. `requireAuth` lo deja en `req`, nunca
 * viene del cliente.
 *
 * Las invitaciones no se mandan por mail: se genera un link que el propietario
 * comparte como quiera. Para un comercio chico —el dueño dando de alta a su
 * empleado, los dos en el mostrador— es mas directo que un correo, y ademas
 * evita atar esta HU al proveedor de mail que todavia no esta definido (HU-3).
 */

/** Cuanto vive una invitacion antes de vencer. */
const HORAS_DE_VIGENCIA = 48;

const ROLES_VALIDOS = Object.values(ROLES);

function exigirRolValido(rol) {
  if (!ROLES_VALIDOS.includes(rol)) {
    throw new ErrorDeNegocio(
      `Rol inválido. Los aceptados son: ${ROLES_VALIDOS.join(", ")}`,
      400,
    );
  }

  return rol;
}

/** Lista el equipo del comercio, con el rol de cada uno. */
export async function listarMiembros(organizationId) {
  return db
    .select({
      id: member.id,
      userId: member.userId,
      nombre: user.name,
      correo: user.email,
      rol: member.role,
      desde: member.createdAt,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(member.createdAt);
}

/** Invitaciones que todavia se pueden usar: ni vencidas ni ya aceptadas. */
export async function listarInvitacionesPendientes(organizationId) {
  return db
    .select({
      id: invitation.id,
      correo: invitation.email,
      rol: invitation.role,
      venceEl: invitation.expiresAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(invitation.createdAt);
}

/**
 * Cuenta cuantos propietarios quedan.
 *
 * Se usa para no permitir que el comercio se quede sin ninguno: sin
 * propietario nadie podria volver a administrar usuarios, y no habria forma de
 * recuperarlo desde la app.
 */
async function contarPropietarios(organizationId) {
  const filas = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.role, ROLES.PROPIETARIO),
      ),
    );

  return filas.length;
}

/** Busca una membresia dentro del comercio, o falla con 404. */
async function exigirMiembro(organizationId, miembroId) {
  const [fila] = await db
    .select({ id: member.id, userId: member.userId, rol: member.role })
    .from(member)
    .where(
      and(eq(member.id, miembroId), eq(member.organizationId, organizationId)),
    )
    .limit(1);

  if (!fila) {
    // 404 y no 403: para este comercio esa membresia no existe.
    throw new ErrorDeNegocio("El miembro no existe", 404);
  }

  return fila;
}

/**
 * Crea una invitacion y devuelve lo necesario para armar el link.
 *
 * El correo se guarda para saber a quien se invito, pero no se valida contra
 * usuarios existentes: quien acepte puede registrarse en ese momento.
 */
export async function invitar({ organizationId, invitadoPor, correo, rol }) {
  exigirRolValido(rol);

  const correoNormalizado =
    typeof correo === "string" ? correo.trim().toLowerCase() : "";

  if (!correoNormalizado) {
    throw new ErrorDeNegocio("El correo del invitado es obligatorio", 400);
  }

  const yaEsMiembro = await db
    .select({ id: member.id })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(user.email, correoNormalizado),
      ),
    )
    .limit(1);

  if (yaEsMiembro.length > 0) {
    throw new ErrorDeNegocio("Esa persona ya es parte del comercio", 409);
  }

  const venceEl = new Date(Date.now() + HORAS_DE_VIGENCIA * 60 * 60 * 1000);

  const [creada] = await db
    .insert(invitation)
    .values({
      id: randomUUID(),
      organizationId,
      email: correoNormalizado,
      role: rol,
      status: "pending",
      expiresAt: venceEl,
      inviterId: invitadoPor,
    })
    .returning({
      id: invitation.id,
      correo: invitation.email,
      rol: invitation.role,
      venceEl: invitation.expiresAt,
    });

  return creada;
}

/** Cancela una invitacion pendiente. */
export async function cancelarInvitacion(organizationId, invitacionId) {
  const [cancelada] = await db
    .update(invitation)
    .set({ status: "canceled" })
    .where(
      and(
        eq(invitation.id, invitacionId),
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
      ),
    )
    .returning({ id: invitation.id });

  if (!cancelada) {
    throw new ErrorDeNegocio("La invitación no existe o ya no está pendiente", 404);
  }

  return cancelada;
}

/**
 * Cambia el rol de un miembro.
 *
 * Dos cosas que no se permiten, y no por capricho:
 *
 * - Cambiarse el rol a uno mismo. Un propietario que se baja a empleado por
 *   error se deja afuera de la administracion sin manera de volver.
 * - Bajar al ultimo propietario. Dejaria el comercio sin nadie que pueda
 *   gestionar usuarios.
 */
export async function cambiarRol({ organizationId, miembroId, rol, userId }) {
  exigirRolValido(rol);

  const miembro = await exigirMiembro(organizationId, miembroId);

  if (miembro.userId === userId) {
    throw new ErrorDeNegocio("No podés cambiarte el rol a vos mismo", 400);
  }

  if (miembro.rol === ROLES.PROPIETARIO && rol !== ROLES.PROPIETARIO) {
    const cuantos = await contarPropietarios(organizationId);

    if (cuantos <= 1) {
      throw new ErrorDeNegocio(
        "El comercio tiene que quedar con al menos un propietario",
        409,
      );
    }
  }

  const [actualizado] = await db
    .update(member)
    .set({ role: rol })
    .where(eq(member.id, miembroId))
    .returning({ id: member.id, rol: member.role });

  return actualizado;
}

/** Saca a alguien del comercio, con los mismos cuidados que el cambio de rol. */
export async function quitarMiembro({ organizationId, miembroId, userId }) {
  const miembro = await exigirMiembro(organizationId, miembroId);

  if (miembro.userId === userId) {
    throw new ErrorDeNegocio("No podés quitarte a vos mismo del comercio", 400);
  }

  if (miembro.rol === ROLES.PROPIETARIO) {
    const cuantos = await contarPropietarios(organizationId);

    if (cuantos <= 1) {
      throw new ErrorDeNegocio(
        "El comercio tiene que quedar con al menos un propietario",
        409,
      );
    }
  }

  await db.delete(member).where(eq(member.id, miembroId));

  return { id: miembroId };
}

/* ---------------------------------------------------------------------------
 * Aceptar una invitacion
 * ------------------------------------------------------------------------- */

/** Datos publicos de una invitacion, para mostrarlos antes de aceptarla. */
export async function verInvitacion(invitacionId) {
  const [fila] = await db
    .select({
      id: invitation.id,
      organizationId: invitation.organizationId,
      correo: invitation.email,
      rol: invitation.role,
      estado: invitation.status,
      venceEl: invitation.expiresAt,
    })
    .from(invitation)
    .where(eq(invitation.id, invitacionId))
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("La invitación no existe", 404);
  }

  if (fila.estado !== "pending") {
    throw new ErrorDeNegocio("Esa invitación ya no está disponible", 410);
  }

  if (fila.venceEl <= new Date()) {
    throw new ErrorDeNegocio("La invitación venció", 410);
  }

  return fila;
}

/**
 * Suma al usuario logueado al comercio que lo invito.
 *
 * La membresia y el consumo de la invitacion van en una transaccion: si una
 * falla, la invitacion sigue disponible en vez de quedar gastada sin efecto.
 */
export async function aceptarInvitacion({ invitacionId, userId }) {
  const invitacionValida = await verInvitacion(invitacionId);

  const yaEsMiembro = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, invitacionValida.organizationId),
        eq(member.userId, userId),
      ),
    )
    .limit(1);

  if (yaEsMiembro.length > 0) {
    throw new ErrorDeNegocio("Ya sos parte de ese comercio", 409);
  }

  return db.transaction(async (tx) => {
    const [creada] = await tx
      .insert(member)
      .values({
        id: randomUUID(),
        organizationId: invitacionValida.organizationId,
        userId,
        role: invitacionValida.rol ?? ROLES.EMPLEADO,
        createdAt: new Date(),
      })
      .returning({ id: member.id, rol: member.role });

    // Se marca aceptada dentro de la misma transaccion y solo si sigue
    // pendiente: si dos personas abren el link a la vez, una sola entra.
    const [consumida] = await tx
      .update(invitation)
      .set({ status: "accepted" })
      .where(
        and(eq(invitation.id, invitacionId), eq(invitation.status, "pending")),
      )
      .returning({ id: invitation.id });

    if (!consumida) {
      throw new ErrorDeNegocio("Esa invitación ya fue usada", 409);
    }

    return creada;
  });
}

/** Los roles que se pueden asignar, para que la pantalla los ofrezca. */
export function rolesAsignables() {
  return ROLES_VALIDOS.map((rol) => ({
    id: rol,
    permisos: Object.entries(roles[rol].statements)
      .filter(([, acciones]) => acciones.length > 0)
      .map(([recurso]) => recurso),
  }));
}
