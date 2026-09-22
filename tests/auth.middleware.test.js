import { describe, expect, jest, test } from "@jest/globals";
import {
  SIN_PERMISO,
  bloquearOrganizacionDirecta,
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

  test("responde 403 ante un rol desconocido, no 401", () => {
    const next = jest.fn();
    const res = armarRes();

    // Hay sesion (viene `rol`), lo invalido es el rol. Un 401 haria que el
    // front deslogueara y entrara en loop de login.
    requirePermission({ producto: ["read"] })({ rol: "intruso" }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test("responde 401 cuando no hay sesion", () => {
    const next = jest.fn();
    const res = armarRes();

    requirePermission({ producto: ["read"] })({}, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("Un solo formato de 403 por rol (HU-32)", () => {
  test("requirePermission y requireRole responden el mismo cuerpo", () => {
    const porPermiso = armarRes();
    const porRol = armarRes();

    requirePermission({ auditoria: ["read"] })(
      { rol: "empleado" },
      porPermiso,
      jest.fn(),
    );
    requireRole("propietario")({ rol: "empleado" }, porRol, jest.fn());

    expect(porPermiso.json).toHaveBeenCalledWith({ error: SIN_PERMISO });
    expect(porRol.json).toHaveBeenCalledWith({ error: SIN_PERMISO });
  });
});

describe("bloquearOrganizacionDirecta", () => {
  // Mira la URL completa, no `req.path`: ver el comentario del middleware.
  test.each([
    "/api/auth/organization/list-members",
    "/api/auth/organization/list-members?organizationId=abc",
    "/api/auth/organization",
    "/api/auth//organization/list-members",
    "/api/auth/Organization/list-members",
    "/api/auth/organization%2Flist-members",
    "/api/auth/%6Frganization/update",
    "/api/auth/x/../organization/delete",
    "/api/auth/x/%2e%2e/organization/delete",
    "/api/auth/./organization/list-invitations",
    "/api/auth\\organization\\list-members",
    // Suben por encima del montaje y vuelven a bajar.
    "/api/auth/../auth/organization/list-members",
    "/api/auth/%2e%2e/auth/organization/list-members",
    "/api/auth/x/../../auth/organization/list-members",
    "/api/auth/../../api/auth/organization/list-members",
  ])("cierra %s con el 403 de siempre", (originalUrl) => {
    const next = jest.fn();
    const res = armarRes();

    bloquearOrganizacionDirecta({ originalUrl }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: SIN_PERMISO });
  });

  test.each([
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
    "/api/auth/sign-out",
    "/api/auth/get-session",
    "/api/auth/request-password-reset",
    "/api/auth/reset-password",
    // El query string no es parte del camino.
    "/api/auth/get-session?x=/organization",
    // Que empiece parecido no alcanza: tiene que ser el segmento entero.
    "/api/auth/organizations-no-existe",
  ])("deja pasar %s", (originalUrl) => {
    const next = jest.fn();
    const res = armarRes();

    bloquearOrganizacionDirecta({ originalUrl }, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("un escape roto es un 400, no un 500", () => {
    const next = jest.fn();
    const res = armarRes();

    bloquearOrganizacionDirecta(
      { originalUrl: "/api/auth/%E0%A4%A" },
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
