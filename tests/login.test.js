import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { auth } from "../src/lib/auth.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, user } from "../src/db/schema.js";

/**
 * Test de integracion de HU-2 (inicio de sesion).
 *
 * El endpoint lo resuelve Better Auth, asi que lo que se verifica no es la
 * implementacion sino el contrato con el que cuenta el resto del sistema: que
 * valide credenciales de verdad, que entregue una sesion utilizable, y que esa
 * sesion caduque por inactividad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const EMAIL = `test-hu2-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

/** Extrae las cookies de una respuesta en el formato que espera `Cookie:`. */
function cookiesDe(respuesta) {
  return (respuesta.headers["set-cookie"] ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

beforeAll(async () => {
  const alta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: "Login de prueba", email: EMAIL, password: PASSWORD });

  // Si el alta falla, los tests de abajo fallarian por un motivo equivocado.
  // Mejor cortar acá con el codigo real que devolvio.
  if (alta.status !== 200) {
    throw new Error(
      `No se pudo crear el usuario de prueba: HTTP ${alta.status} ${JSON.stringify(alta.body)}`,
    );
  }
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

describe("POST /api/auth/sign-in/email", () => {
  test("entra con las credenciales correctas y entrega una sesion", async () => {
    const respuesta = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: EMAIL, password: PASSWORD });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.user.email).toBe(EMAIL);
    expect(cookiesDe(respuesta)).toContain("better-auth.session_token");
  });

  test("la cookie de sesion es HttpOnly", async () => {
    const respuesta = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: EMAIL, password: PASSWORD });

    const cookieDeSesion = (respuesta.headers["set-cookie"] ?? []).find(
      (cookie) => cookie.startsWith("better-auth.session_token"),
    );

    // Sin HttpOnly, cualquier script de la pagina podria leer el token.
    expect(cookieDeSesion).toMatch(/HttpOnly/i);
  });

  test("rechaza una contrasena incorrecta", async () => {
    const respuesta = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: EMAIL, password: "claveEquivocada123" });

    expect(respuesta.status).toBe(401);
  });

  test("rechaza un correo que no existe", async () => {
    const respuesta = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: `nadie-${SUFIJO}@test.local`, password: PASSWORD });

    expect(respuesta.status).toBe(401);
  });

  test("no distingue entre correo inexistente y contrasena mala", async () => {
    // Si las dos respuestas difirieran, se podria averiguar que correos estan
    // registrados probando de a uno.
    const claveMala = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: EMAIL, password: "claveEquivocada123" });

    const correoInexistente = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: `nadie-${SUFIJO}@test.local`, password: PASSWORD });

    expect(claveMala.status).toBe(correoInexistente.status);
    expect(claveMala.body.code).toBe(correoInexistente.body.code);
  });
});

describe("La sesion sirve para operar", () => {
  test("con la cookie del login se accede a un endpoint de negocio", async () => {
    const login = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: EMAIL, password: PASSWORD });

    const configuracion = await request(app)
      .get("/api/configuracion")
      .set("Cookie", cookiesDe(login));

    expect(configuracion.status).toBe(200);
    expect(configuracion.body.moneda).toBe("ARS");
  });

  test("sin cookie el mismo endpoint responde 401", async () => {
    const respuesta = await request(app).get("/api/configuracion");

    expect(respuesta.status).toBe(401);
  });

  test("cerrar sesion invalida la cookie", async () => {
    const login = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: EMAIL, password: PASSWORD });

    const cookie = cookiesDe(login);

    await request(app).post("/api/auth/sign-out").set("Cookie", cookie);

    const despues = await request(app)
      .get("/api/configuracion")
      .set("Cookie", cookie);

    expect(despues.status).toBe(401);
  });
});

describe("Expiracion por inactividad", () => {
  test("la sesion vive 8 horas y se renueva como mucho una vez por hora", () => {
    // El criterio de aceptacion pide que la sesion "se cierre automaticamente
    // por inactividad". Better Auth lo resuelve con expiracion deslizante:
    // `expiresIn` es cuanto vive desde la ultima actividad y `updateAge` cada
    // cuanto se renueva mientras el usuario sigue usando la app. Si alguien
    // cambia estos valores sin querer, este test lo frena.
    expect(auth.options.session.expiresIn).toBe(60 * 60 * 8);
    expect(auth.options.session.updateAge).toBe(60 * 60);
  });

  test("el login emite una sesion que caduca dentro de esas 8 horas", async () => {
    const antes = Date.now();

    const login = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: EMAIL, password: PASSWORD });

    const sesion = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", cookiesDe(login));

    const caduca = new Date(sesion.body.session.expiresAt).getTime();
    const horas = (caduca - antes) / (1000 * 60 * 60);

    expect(horas).toBeGreaterThan(7.9);
    expect(horas).toBeLessThanOrEqual(8.1);
  });
});
