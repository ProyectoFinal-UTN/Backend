import { describe, expect, test } from "@jest/globals";
import { ROLES, empleado, gerente, propietario } from "../src/lib/permissions.js";

describe("Roles de RF9", () => {
  test("los tres roles se llaman exactamente como manda el proyecto", () => {
    expect(Object.values(ROLES)).toEqual([
      "propietario",
      "gerente",
      "empleado",
    ]);
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

  test("solo el propietario modifica los datos del comercio", () => {
    expect(propietario.authorize({ comercio: ["update"] }).success).toBe(true);
    expect(gerente.authorize({ comercio: ["update"] }).success).toBe(false);
    expect(empleado.authorize({ comercio: ["update"] }).success).toBe(false);
  });
});
