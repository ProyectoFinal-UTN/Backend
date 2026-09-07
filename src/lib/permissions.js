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
  alerta: ["read", "update"],
  auditoria: ["read"],
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
  member: ["create", "read", "update", "delete"],
  comercio: ["read", "update"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  alerta: ["read", "update"],
  auditoria: ["read"],
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
  member: ["read"],
  invitation: [],
  comercio: ["read"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  alerta: ["read", "update"],
  auditoria: [],
});

/**
 * Empleado: registra movimientos y consulta, no configura ni borra.
 *
 * No accede a la gestión de usuarios, que es un criterio de aceptación
 * explícito de HU-4: ni siquiera puede ver la lista del equipo.
 */
export const empleado = ac.newRole({
  ...memberAc.statements,
  member: [],
  invitation: [],
  comercio: ["read"],
  producto: ["read"],
  ubicacion: ["read"],
  proveedor: ["read"],
  movimiento: ["create", "read"],
  alerta: ["read"],
  auditoria: [],
});

export const roles = { propietario, gerente, empleado };

/** Los tres roles de RF9, para validar contra ellos sin repetir strings. */
export const ROLES = Object.freeze({
  PROPIETARIO: "propietario",
  GERENTE: "gerente",
  EMPLEADO: "empleado",
});
