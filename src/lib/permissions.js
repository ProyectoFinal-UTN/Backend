import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

/**
 * Recursos del dominio sobre los que se otorgan permisos, además de los que
 * trae el plugin de organización (organization, member, invitation, team, ac).
 *
 * Esta es la matriz que define qué puede hacer cada rol (RF9). Al agregar un
 * módulo nuevo, sumar acá su recurso y repartirlo entre los tres roles: es el
 * único lugar donde se decide, y las rutas lo consultan con
 * `requirePermission` sin saber de roles.
 *
 * Los `...xxxAc.statements` de cada rol existen solo para el plugin de
 * organización, y traen permisos que este proyecto no usa (`organization`,
 * `team`, `ac`). Se pisan con `[]` a propósito (HU-32): los endpoints del
 * plugin están cerrados en `app.js`, pero si algún día se reabren, un rol no
 * tiene que heredar por defecto algo que la matriz nunca le dio. Por ejemplo,
 * `adminAc` le daba al gerente `organization: ["update"]` —renombrar el
 * comercio— cuando acá no tiene `comercio: ["update"]`.
 */
export const statements = {
  ...defaultStatements,
  // El plugin trae `member` con create/update/delete pero sin `read`, y hace
  // falta para poder listar el equipo sin poder modificarlo.
  member: [...defaultStatements.member, "read"],
  comercio: ["read", "update"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  // Separado de `movimiento` (HU-32): mover mercadería entre locales es una
  // decisión distinta de registrar una venta, y así se puede restringir sin
  // tocar movimientos. La lectura sigue por `movimiento: ["read"]`, porque las
  // dos patas de una transferencia son movimientos del historial (HU-14).
  transferencia: ["create"],
  alerta: ["read", "update"],
  auditoria: ["read"],
  // Los datos de la propia persona (HU-31): descargarlos y darse de baja. Los
  // tienen los tres roles, pero pasan por la matriz igual que el resto para que
  // "todo endpoint valida el rol" (HU-32) no tenga excepciones que recordar.
  cuenta: ["read", "delete"],
};

export const ac = createAccessControl(statements);

/**
 * Dueño del comercio: control total.
 *
 * Único rol que administra usuarios (HU-4) y que ve la auditoría (E7). La
 * historia lo dice literal: "como propietario, quiero asignar a cada usuario
 * un rol".
 */
export const propietario = ac.newRole({
  ...ownerAc.statements,
  // `ownerAc` trae `organization: ["update", "delete"]`. Los datos del
  // comercio se editan por `PUT /api/comercio`, y borrar la organización
  // dejaría al comercio huérfano y a todo el equipo con 403.
  organization: [],
  team: [],
  ac: [],
  member: ["create", "read", "update", "delete"],
  comercio: ["read", "update"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  transferencia: ["create"],
  alerta: ["read", "update"],
  auditoria: ["read"],
  cuenta: ["read", "delete"],
});

/**
 * Encargado: opera el negocio completo, pero no lo administra.
 *
 * Ve quiénes son sus compañeros —necesita saber quién registró cada
 * movimiento— pero no cambia roles ni invita gente: eso es del propietario.
 * Tampoco accede a la auditoría.
 */
export const gerente = ac.newRole({
  ...adminAc.statements,
  organization: [],
  team: [],
  ac: [],
  member: ["read"],
  invitation: [],
  comercio: ["read"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  transferencia: ["create"],
  alerta: ["read", "update"],
  auditoria: [],
  cuenta: ["read", "delete"],
});

/**
 * Empleado: registra movimientos y consulta, no configura ni borra.
 *
 * No accede a la gestión de usuarios, que es un criterio de aceptación
 * explícito de HU-4: ni siquiera puede ver la lista del equipo.
 */
export const empleado = ac.newRole({
  ...memberAc.statements,
  ac: [],
  member: [],
  invitation: [],
  comercio: ["read"],
  producto: ["read"],
  ubicacion: ["read"],
  proveedor: ["read"],
  movimiento: ["create", "read"],
  transferencia: ["create"],
  alerta: ["read"],
  auditoria: [],
  cuenta: ["read", "delete"],
});

export const roles = { propietario, gerente, empleado };

/**
 * Si un rol tiene ciertos permisos, para recortar datos en un service.
 *
 *   puede(rol, { member: ["read"] })
 *
 * Es para cuando el endpoint se puede llamar pero la respuesta cambia según
 * el rol (HU-32): para bloquear el endpoint entero se usa `requirePermission`
 * en la ruta. Un rol desconocido no puede nada.
 */
export function puede(rol, permisos) {
  return roles[rol]?.authorize(permisos).success === true;
}

/**
 * Recursos del plugin de organización que no significan nada para el
 * Frontend. Hoy están en `[]` para los tres roles, así que el filtro de listas
 * vacías ya los sacaría; la lista explícita evita que se filtren a la API si
 * alguna vez vuelven a tener valor.
 */
const SOLO_DEL_PLUGIN = ["organization", "team", "ac"];

/**
 * Los permisos efectivos de un rol, para que el Frontend esconda lo que ese
 * rol no puede usar (HU-32, SCRUM-108) sin mantener su propia copia de la
 * matriz.
 *
 *   permisosDe("empleado") -> { producto: ["read"], movimiento: [...], ... }
 *
 * Devuelve solo los del rol que pregunta: un empleado no tiene por qué saber
 * qué puede hacer un propietario. Los recursos sin ninguna acción se omiten,
 * porque no son un permiso sino la ausencia de uno. Un rol desconocido no
 * tiene ninguno, igual que en `puede`.
 *
 * Es presentación: la autoridad sigue siendo `requirePermission` en cada
 * endpoint.
 */
export function permisosDe(rol) {
  const statements = roles[rol]?.statements;

  if (!statements) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(statements)
      .filter(
        ([recurso, acciones]) =>
          acciones.length > 0 && !SOLO_DEL_PLUGIN.includes(recurso),
      )
      // Copia de cada lista: la matriz es estado compartido del proceso y
      // quien reciba esto no tiene que poder modificarla sin querer.
      .map(([recurso, acciones]) => [recurso, [...acciones]]),
  );
}

/** Los tres roles de RF9, para validar contra ellos sin repetir strings. */
export const ROLES = Object.freeze({
  PROPIETARIO: "propietario",
  GERENTE: "gerente",
  EMPLEADO: "empleado",
});
