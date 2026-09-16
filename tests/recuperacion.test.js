import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { account, comercio, member, organization, user } from "../src/db/schema.js";
import {
  armarCorreoDeRecuperacion,
  armarLinkDeRecuperacion,
} from "../src/services/recuperacion.service.js";

/**
 * Test de integracion de HU-3 (recuperacion de contrasena).
 *
 * El ciclo del token lo maneja Better Auth, asi que lo que se prueba aca es lo
 * que agregamos nosotros: que el link vaya al Frontend, que el correo diga lo
 * que tiene que decir, y sobre todo que el endpoint no revele que correos
 * estan registrados.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = "unaClaveSegura123";

const correoDe = (etiqueta) => `test-hu3-${etiqueta}-${SUFIJO}@test.local`;

const usuariosCreados = [];
const comerciosCreados = [];

async function registrar(etiqueta) {
  const email = correoDe(etiqueta);

  const alta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: etiqueta, email, password: PASSWORD });

  if (alta.status !== 200) {
    throw new Error(`No se pudo registrar a ${etiqueta}: ${alta.status}`);
  }

  const id = alta.body.user.id;
  usuariosCreados.push(id);

  const [membresia] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, id));

  comerciosCreados.push(membresia.organizationId);

  return { id, email };
}

let dueno;

beforeAll(async () => {
  dueno = await registrar("dueno");
});

afterAll(async () => {
  if (comerciosCreados.length > 0) {
    await db
      .delete(comercio)
      .where(inArray(comercio.organizationId, comerciosCreados));
  }

  if (usuariosCreados.length > 0) {
    await db.delete(user).where(inArray(user.id, usuariosCreados));
  }

  if (comerciosCreados.length > 0) {
    await db
      .delete(organization)
      .where(inArray(organization.id, comerciosCreados));
  }

  await cerrarConexion();
});

describe("El link del correo", () => {
  test("apunta al Frontend, no al backend", () => {
    // La pantalla que pide la contraseña nueva vive en el Frontend. Si el link
    // fuera al backend haría un salto de más sin ganar nada.
    const link = armarLinkDeRecuperacion("abc123");

    expect(link).toContain("/restablecer?token=abc123");
    expect(link).not.toContain(":4000");
  });

  test("escapa el token en la URL", () => {
    // Un token con caracteres especiales sin escapar cortaría la query string
    // y el link llegaría roto.
    expect(armarLinkDeRecuperacion("a+b/c=d")).toContain(
      `token=${encodeURIComponent("a+b/c=d")}`,
    );
  });
});

describe("El contenido del correo", () => {
  const armado = () =>
    armarCorreoDeRecuperacion({
      correo: "ana@kiosco.com",
      link: "http://localhost:5173/restablecer?token=t",
    });

  test("va en texto y en HTML, con el link en los dos", () => {
    // Hay clientes que no muestran HTML, y un correo vacío es peor que uno feo.
    const { texto, html } = armado();

    expect(texto).toContain("http://localhost:5173/restablecer?token=t");
    expect(html).toContain("http://localhost:5173/restablecer?token=t");
  });

  test("avisa que vence y que se usa una sola vez", () => {
    const { texto } = armado();

    expect(texto).toMatch(/vence/i);
    expect(texto).toMatch(/una sola vez/i);
  });

  test("le dice qué hacer a quien no lo pidió", () => {
    // Si no se aclara, un correo así asusta: parece que alguien ya entró.
    expect(armado().texto).toMatch(/si no lo pediste/i);
  });

  test("nunca lleva la contraseña", () => {
    const { texto, html } = armado();

    expect(texto.toLowerCase()).not.toContain("contraseña:");
    expect(html).not.toMatch(/\$2[aby]\$/);
  });
});

describe("Pedir la recuperación", () => {
  test("responde 200 para un correo registrado", async () => {
    const respuesta = await request(app)
      .post("/api/auth/request-password-reset")
      .send({ email: dueno.email, redirectTo: "/restablecer" });

    expect(respuesta.status).toBe(200);
  });

  test("responde igual para un correo que no existe", async () => {
    // Es el criterio que importa: si contestara distinto, alcanzaría con
    // probar de a uno para averiguar quiénes tienen cuenta.
    const registrado = await request(app)
      .post("/api/auth/request-password-reset")
      .send({ email: dueno.email, redirectTo: "/restablecer" });

    const inventado = await request(app)
      .post("/api/auth/request-password-reset")
      .send({ email: correoDe("no-existe"), redirectTo: "/restablecer" });

    expect(inventado.status).toBe(registrado.status);
    expect(inventado.body).toEqual(registrado.body);
  });

  test("no crea una cuenta para el correo inventado", async () => {
    const encontrados = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, correoDe("no-existe")));

    expect(encontrados).toHaveLength(0);
  });
});

describe("Cambiar la contraseña", () => {
  test("un token inventado no sirve", async () => {
    const respuesta = await request(app)
      .post("/api/auth/reset-password")
      .send({ newPassword: "otraClaveSegura123", token: "no-es-un-token" });

    expect(respuesta.status).toBeGreaterThanOrEqual(400);
  });

  test("con un token inválido la contraseña vieja sigue sirviendo", async () => {
    // Que el rechazo no haya tocado nada por el camino.
    const login = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: dueno.email, password: PASSWORD });

    expect(login.status).toBe(200);
  });

  test("la contraseña guardada sigue siendo un hash bcrypt", async () => {
    const [credencial] = await db
      .select({ password: account.password })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.email, dueno.email));

    expect(credencial.password).toMatch(/^\$2[aby]\$\d{2}\$/);
  });
});
