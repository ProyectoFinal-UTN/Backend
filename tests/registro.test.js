import { afterAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  account,
  comercio,
  member,
  organization,
  user,
} from "../src/db/schema.js";
import { eq, inArray, like } from "drizzle-orm";

/**
 * Test de integracion de HU-1 (registro de usuario propietario).
 *
 * Corre contra la base real, porque lo que se verifica es justamente el
 * encadenado que arma Better Auth mas el hook de creacion del comercio:
 * Better Auth crea el `user` y el hook crea `organization`, `member` y `comercio`
 * en una sola transaccion. Mockear la base dejaria sin probar lo unico que importa aca.
 *
 * Cada corrida usa un correo unico y limpia lo suyo al final.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu1-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  // Las organizaciones de este test se identifican ANTES de borrar los
  // usuarios: `member` cae por cascada y despues no habria como encontrarlas.
  // Se borra solo por id, nunca por descarte, para no tocar datos ajenos.
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

describe("POST /api/auth/sign-up/email", () => {
  test("registra al propietario y le arma el comercio completo", async () => {
    const email = correo("alta");

    const respuesta = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Comerciante de prueba", email, password: PASSWORD });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.user.email).toBe(email);

    const [creado] = await db
      .select({
        userId: user.id,
        rol: member.role,
        comercioId: comercio.id,
        nombreComercio: comercio.nombre,
        moneda: comercio.moneda,
      })
      .from(user)
      .innerJoin(member, eq(member.userId, user.id))
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .innerJoin(comercio, eq(comercio.organizationId, organization.id))
      .where(eq(user.email, email));

    expect(creado).toBeDefined();
    expect(creado.rol).toBe("propietario");
    expect(creado.comercioId).toBeTruthy();
    expect(creado.moneda).toBe("ARS");
  });

  test("deja la sesion iniciada al registrarse", async () => {
    const email = correo("sesion");

    const respuesta = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Con sesion", email, password: PASSWORD });

    expect(respuesta.status).toBe(200);

    const cookies = respuesta.headers["set-cookie"] ?? [];
    expect(cookies.join(";")).toContain("better-auth.session_token");
  });

  test("rechaza un correo ya registrado con un mensaje claro", async () => {
    const email = correo("duplicado");

    const primera = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Primero", email, password: PASSWORD });
    expect(primera.status).toBe(200);

    const segunda = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Segundo", email, password: "otraClaveDistinta456" });

    expect(segunda.status).toBe(422);
    expect(segunda.body.code).toBe("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
    expect(segunda.body.message).toMatch(/already exists/i);
  });

  test("guarda la contrasena hasheada con bcrypt, nunca en texto plano", async () => {
    const email = correo("hash");

    await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Hash", email, password: PASSWORD });

    const [credencial] = await db
      .select({ password: account.password })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.email, email));

    expect(credencial.password).not.toBe(PASSWORD);
    expect(credencial.password).not.toContain(PASSWORD);
    // $2a$ / $2b$ / $2y$ + coste, y 60 caracteres: la firma de bcrypt.
    expect(credencial.password).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(credencial.password).toHaveLength(60);
  });

  test("no acepta contrasenas mas largas de lo que bcrypt puede distinguir", async () => {
    // bcrypt ignora todo lo que pase de 72 bytes: sin este tope, dos frases
    // que compartan ese prefijo servirian indistintamente para entrar.
    const respuesta = await request(app)
      .post("/api/auth/sign-up/email")
      .send({
        name: "Clave larguisima",
        email: correo("larga"),
        password: "a".repeat(73),
      });

    expect(respuesta.status).toBeGreaterThanOrEqual(400);
  });

  test("no permite contrasenas mas cortas que el minimo", async () => {
    const respuesta = await request(app)
      .post("/api/auth/sign-up/email")
      .send({ name: "Clave corta", email: correo("corta"), password: "abc" });

    expect(respuesta.status).toBeGreaterThanOrEqual(400);
  });
});
