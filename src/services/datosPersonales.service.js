import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  account,
  auditoria,
  comercio,
  member,
  session,
  user,
} from "../db/schema.js";
import { ErrorDeNegocio } from "../lib/errores.js";
import { ROLES } from "../lib/permissions.js";

/**
 * Derechos sobre los datos personales (HU-31, Ley 25.326).
 *
 * La ley reconoce el derecho de acceso (saber que se guarda de uno) y el de
 * supresion (pedir que se borre). Aca se implementan los dos.
 */

/** Con lo que se reemplazan los datos que identifican a la persona. */
const NOMBRE_ANONIMO = "Usuario eliminado";

/**
 * Devuelve todo lo que el sistema guarda de una persona (derecho de acceso).
 *
 * Incluye tanto los datos de la cuenta como el rastro de actividad, porque
 * ambos son datos personales: saber que alguien entro a tal hora tambien dice
 * algo de esa persona.
 *
 * No incluye la contrasena, ni siquiera hasheada: el hash es justamente lo que
 * no debe salir nunca del sistema.
 */
export async function exportarDatos(userId) {
  const [datosCuenta] = await db
    .select({
      nombre: user.name,
      correo: user.email,
      correoVerificado: user.emailVerified,
      creadaEl: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!datosCuenta) {
    throw new ErrorDeNegocio("La cuenta no existe", 404);
  }

  const membresias = await db
    .select({
      comercio: comercio.nombre,
      rol: member.role,
      desde: member.createdAt,
    })
    .from(member)
    .innerJoin(comercio, eq(comercio.organizationId, member.organizationId))
    .where(eq(member.userId, userId));

  const sesiones = await db
    .select({
      creadaEl: session.createdAt,
      expiraEl: session.expiresAt,
      ip: session.ipAddress,
      navegador: session.userAgent,
    })
    .from(session)
    .where(eq(session.userId, userId));

  const actividad = await db
    .select({
      accion: auditoria.accion,
      recurso: auditoria.recurso,
      fecha: auditoria.createdAt,
      ip: auditoria.ip,
    })
    .from(auditoria)
    .where(eq(auditoria.usuarioId, userId));

  return {
    generadoEl: new Date().toISOString(),
    cuenta: datosCuenta,
    comercios: membresias,
    sesionesActivas: sesiones,
    actividadRegistrada: actividad,
    // Se dice explicitamente lo que NO esta, para que quede claro que no es
    // un olvido.
    nota:
      "No se incluye la contraseña: se guarda solo como hash bcrypt y no se " +
      "puede recuperar. Los movimientos de stock que hayas registrado no son " +
      "datos personales tuyos sino del comercio, y quedan en su libro contable.",
  };
}

/**
 * Cuenta cuantos propietarios le quedan a un comercio.
 * Se usa para no dejarlo sin nadie que pueda administrarlo.
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

/**
 * Da de baja la cuenta, anonimizando en vez de borrar la fila (derecho de
 * supresion).
 *
 * Por que anonimizar y no un DELETE: `movimiento.usuario_id` es `notNull` con
 * `onDelete: restrict`, porque el libro de movimientos es append-only y tiene
 * que saber quien registro cada uno. Un DELETE fallaria para cualquier usuario
 * que haya hecho un movimiento, o sea, para casi todos.
 *
 * La anonimizacion resuelve la tension: se eliminan los datos que identifican
 * a la persona y la fila queda para que el libro conserve su integridad. Un
 * registro que ya no identifica a nadie deja de ser un dato personal, que es
 * lo que la ley protege.
 *
 * Lo que si se borra de verdad: las credenciales y las sesiones. Despues de
 * esto no se puede volver a entrar con esa cuenta.
 */
export async function darDeBajaCuenta(userId) {
  const membresias = await db
    .select({ organizationId: member.organizationId, rol: member.role })
    .from(member)
    .where(eq(member.userId, userId));

  // Si es el unico propietario de algun comercio, ese comercio quedaria sin
  // nadie que pueda administrarlo y sin forma de recuperarlo desde la app.
  for (const membresia of membresias) {
    if (membresia.rol !== ROLES.PROPIETARIO) {
      continue;
    }

    const cuantos = await contarPropietarios(membresia.organizationId);

    if (cuantos <= 1) {
      throw new ErrorDeNegocio(
        "Sos el único propietario de un comercio. Antes de darte de baja, " +
          "asigná el rol de propietario a otra persona.",
        409,
      );
    }
  }

  return db.transaction(async (tx) => {
    // Un correo unico e imposible de recibir: mantiene el unique de la tabla
    // sin dejar nada que sirva para contactar ni identificar.
    const correoAnonimo = `eliminado-${randomUUID()}@invalido.local`;

    await tx
      .update(user)
      .set({
        name: NOMBRE_ANONIMO,
        email: correoAnonimo,
        emailVerified: false,
        image: null,
      })
      .where(eq(user.id, userId));

    // El hash de la contrasena y los tokens se van de verdad.
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(session).where(eq(session.userId, userId));

    // Se sale de los comercios: ya no participa de ninguno.
    await tx.delete(member).where(eq(member.userId, userId));

    // En la auditoria se borra el correo, pero los hechos quedan: son del
    // comercio, no de la persona.
    await tx
      .update(auditoria)
      .set({ usuarioCorreo: NOMBRE_ANONIMO })
      .where(eq(auditoria.usuarioId, userId));

    return { anonimizado: true };
  });
}
