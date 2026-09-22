import { describe, expect, test } from "@jest/globals";
import {
  ROLES,
  empleado,
  gerente,
  propietario,
  puede,
} from "../src/lib/permissions.js";

describe("Roles de RF9", () => {
  test("los tres roles se llaman exactamente como manda el proyecto", () => {
    expect(Object.values(ROLES)).toEqual([
      "propietario",
      "gerente",
      "empleado",
    ]);
  });
});

describe("puede", () => {
  test("consulta la matriz por nombre de rol", () => {
    expect(puede("gerente", { member: ["read"] })).toBe(true);
    expect(puede("empleado", { member: ["read"] })).toBe(false);
  });

  test("un rol desconocido o ausente no puede nada", () => {
    expect(puede("intruso", { producto: ["read"] })).toBe(false);
    expect(puede(undefined, { producto: ["read"] })).toBe(false);
    expect(puede(null, { producto: ["read"] })).toBe(false);
  });
});

describe("Matriz de permisos", () => {
  test("solo el propietario lee la auditoria", () => {
    expect(propietario.authorize({ auditoria: ["read"] }).success).toBe(true);
    expect(gerente.authorize({ auditoria: ["read"] }).success).toBe(false);
    expect(empleado.authorize({ auditoria: ["read"] }).success).toBe(false);
  });

  test("el empleado registra movimientos pero no borra productos", () => {
    expect(empleado.authorize({ movimiento: ["create"] }).success).toBe(true);
    expect(empleado.authorize({ producto: ["delete"] }).success).toBe(false);
  });

  test("el gerente administra el catalogo completo", () => {
    expect(
      gerente.authorize({ producto: ["create", "update", "delete"] }).success,
    ).toBe(true);
    expect(gerente.authorize({ ubicacion: ["create"] }).success).toBe(true);
  });

  test("los tres roles transfieren stock, con un permiso propio (HU-32)", () => {
    for (const rol of [propietario, gerente, empleado]) {
      expect(rol.authorize({ transferencia: ["create"] }).success).toBe(true);
    }
  });

  test("ningun rol hereda del plugin permisos sobre la organizacion", () => {
    // `adminAc` le daba al gerente `organization: ["update"]` y `ownerAc` al
    // propietario `organization: ["delete"]`, por fuera de esta matriz.
    for (const rol of [propietario, gerente, empleado]) {
      expect(rol.authorize({ organization: ["update"] }).success).toBe(false);
      expect(rol.authorize({ organization: ["delete"] }).success).toBe(false);
      expect(rol.authorize({ team: ["create"] }).success).toBe(false);
      expect(rol.authorize({ ac: ["read"] }).success).toBe(false);
    }
  });

  test("los tres roles acceden a sus propios datos (HU-31, HU-32)", () => {
    for (const rol of [propietario, gerente, empleado]) {
      expect(rol.authorize({ cuenta: ["read", "delete"] }).success).toBe(true);
    }
  });

  test("solo el propietario modifica los datos del comercio", () => {
    expect(propietario.authorize({ comercio: ["update"] }).success).toBe(true);
    expect(gerente.authorize({ comercio: ["update"] }).success).toBe(false);
    expect(empleado.authorize({ comercio: ["update"] }).success).toBe(false);
  });
});
