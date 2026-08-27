import { describe, expect, jest, test } from "@jest/globals";
import {
  requirePermission,
  requireRole,
} from "../src/middlewares/auth.middleware.js";

function armarRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe("requireRole", () => {
  test("deja pasar al rol permitido", () => {
    const next = jest.fn();
    const res = armarRes();

    requireRole("propietario", "gerente")({ rol: "gerente" }, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("responde 403 al rol no permitido", () => {
    const next = jest.fn();
    const res = armarRes();

    requireRole("propietario")({ rol: "empleado" }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("responde 401 si no hay sesion", () => {
    const next = jest.fn();
    const res = armarRes();

    requireRole("propietario")({}, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("requirePermission", () => {
  test("deja pasar cuando el rol tiene el permiso", () => {
    const next = jest.fn();
    const res = armarRes();

    requirePermission({ movimiento: ["create"] })(
      { rol: "empleado" },
      res,
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  test("responde 403 cuando el rol no tiene el permiso", () => {
    const next = jest.fn();
    const res = armarRes();

    requirePermission({ auditoria: ["read"] })({ rol: "empleado" }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("responde 401 ante un rol desconocido", () => {
    const next = jest.fn();
    const res = armarRes();

    requirePermission({ producto: ["read"] })({ rol: "intruso" }, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
