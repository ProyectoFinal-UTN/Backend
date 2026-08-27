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
 * La matriz fina de permisos por rol se refina en HU-4; acá se define la base
 * mínima para que los tres roles de RF9 existan y el resto del equipo pueda
 * usar `requireRole` y `requirePermission` desde el primer día.
 */
export const statements = {
  ...defaultStatements,
  comercio: ["read", "update"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  alerta: ["read", "update"],
  auditoria: ["read"],
};

export const ac = createAccessControl(statements);

/** Dueño del comercio: control total, único rol que ve la auditoría (E7). */
export const propietario = ac.newRole({
  ...ownerAc.statements,
  comercio: ["read", "update"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  alerta: ["read", "update"],
  auditoria: ["read"],
});

/** Encargado: opera el negocio completo, pero no accede a la auditoría. */
export const gerente = ac.newRole({
  ...adminAc.statements,
  comercio: ["read"],
  producto: ["create", "read", "update", "delete"],
  ubicacion: ["create", "read", "update", "delete"],
  proveedor: ["create", "read", "update", "delete"],
  movimiento: ["create", "read"],
  alerta: ["read", "update"],
  auditoria: [],
});

/** Empleado: registra movimientos y consulta, no configura ni borra. */
export const empleado = ac.newRole({
  ...memberAc.statements,
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
