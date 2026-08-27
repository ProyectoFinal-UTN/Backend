import { describe, expect, test } from "@jest/globals";
import request from "supertest";
import { app } from "../src/app.js";

describe("GET /health", () => {
  test("responde 200 y el estado del servidor", async () => {
    const respuesta = await request(app).get("/health");

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({ status: "ok" });
  });
});

describe("Rutas protegidas", () => {
  test("una ruta con requireAuth responde 401 sin sesion", async () => {
    const { requireAuth } = await import(
      "../src/middlewares/auth.middleware.js"
    );

    // Se monta al vuelo para probar el middleware sin depender de las rutas
    // que todavia no existen (las trae cada HU).
    app.get("/tests/protegida", requireAuth, (req, res) =>
      res.json({ comercioId: req.comercioId }),
    );

    const respuesta = await request(app).get("/tests/protegida");

    expect(respuesta.status).toBe(401);
    expect(respuesta.body.error).toBe("No hay sesion activa");
  });
});
