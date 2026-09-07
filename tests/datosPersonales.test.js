import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  account,
  comercio,
  member,
  organization,
  session,
  user,
} from "../src/db/schema.js";

/**
 * Test de integracion de HU-31 (proteccion de credenciales y datos).
 *
 * Verifica los tres criterios: el hash de las contrasenas, las cabeceras que
 * protegen el trafico, y los derechos de acceso y supresion de la Ley 25.326.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = "unaClaveSegura123";

const correoDe = (etiqueta) => `test-hu31-${etiqueta}-${SUFIJO}@test.local`;

function cookiesDe(respuesta) {
  return (respuesta.headers["set-cookie"] ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/**
 * Ids de todo lo que crea este archivo, para limpiarlo al final.
 *
 * Se anotan a mano en vez de buscarlos por correo al terminar: la baja
 * anonimiza el correo, asi que despues de correr los tests ya no hay forma de
 * reconocer cuales eran los nuestros. La base es compartida con el equipo.
 */
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

  // El registro crea el comercio del que la persona es propietaria (HU-1).
  const [membresia] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, id));

  comerciosCreados.push(membresia.organizationId);

  return { id, email, organizationId: membresia.organizationId, cookie: cookiesDe(alta) };
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

describe("Criterio 1: contraseñas con hash bcrypt", () => {
  test("la contraseña nunca se guarda en texto plano", async () => {
    const [credencial] = await db
      .select({ password: account.password })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.email, dueno.email));

    expect(credencial.password).not.toBe(PASSWORD);
    expect(credencial.password).not.toContain(PASSWORD);
    // $2a$ / $2b$ / $2y$ + coste, y 60 caracteres: la firma de bcrypt.
    expect(credencial.password).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(credencial.password).toHaveLength(60);
  });

  test("ningún endpoint devuelve el hash", async () => {
    const respuesta = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", dueno.cookie);

    expect(JSON.stringify(respuesta.body)).not.toMatch(/\$2[aby]\$/);
  });
});

describe("Criterio 2: tráfico protegido", () => {
  test("responde con las cabeceras de seguridad", async () => {
    const respuesta = await request(app).get("/health");

    // HSTS: el navegador solo entra por HTTPS a este dominio.
    expect(respuesta.headers["strict-transport-security"]).toBeDefined();
    // Evita que el navegador adivine el tipo de un archivo.
    expect(respuesta.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("no anuncia con qué está hecho el servidor", async () => {
    const respuesta = await request(app).get("/health");

    expect(respuesta.headers["x-powered-by"]).toBeUndefined();
  });

  test("la cookie de sesión es HttpOnly", async () => {
    const login = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: dueno.email, password: PASSWORD });

    const cookie = (login.headers["set-cookie"] ?? []).find((c) =>
      c.startsWith("better-auth.session_token"),
    );

    expect(cookie).toMatch(/HttpOnly/i);
  });

  test("la conexión a la base exige TLS", () => {
    // Sin esto, las credenciales y los datos viajarían en claro hasta Neon.
    expect(process.env.DATABASE_URL).toMatch(/sslmode=(require|verify-full)/);
  });
});

describe("Criterio 3: derecho de acceso", () => {
  test("devuelve todo lo que el sistema guarda de la persona", async () => {
    const respuesta = await request(app)
      .get("/api/mis-datos")
      .set("Cookie", dueno.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.cuenta.correo).toBe(dueno.email);
    expect(respuesta.body.comercios).toHaveLength(1);
    expect(respuesta.body.sesionesActivas.length).toBeGreaterThan(0);
    expect(respuesta.body.actividadRegistrada).toBeDefined();
  });

  test("se ofrece como descarga, no como pantalla", async () => {
    const respuesta = await request(app)
      .get("/api/mis-datos")
      .set("Cookie", dueno.cookie);

    expect(respuesta.headers["content-disposition"]).toMatch(/attachment/);
  });

  test("nunca incluye la contraseña, ni siquiera hasheada", async () => {
    const respuesta = await request(app)
      .get("/api/mis-datos")
      .set("Cookie", dueno.cookie);

    const texto = JSON.stringify(respuesta.body);

    expect(texto).not.toMatch(/\$2[aby]\$/);
    expect(texto.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
  });

  test("sin sesión responde 401", async () => {
    expect((await request(app).get("/api/mis-datos")).status).toBe(401);
  });

  test("no le exige sesión al resto de /api", async () => {
    // Este router se monta en `/api` a secas. Si `requireAuth` se pusiera con
    // un `router.use`, correría en cualquier pedido a `/api/*` aunque no
    // matcheara ninguna ruta de acá, y como responde 401 en vez de seguir la
    // cadena dejaría sin sesión posible a los endpoints públicos de los demás.
    // Una ruta inexistente tiene que dar 404, no 401.
    expect((await request(app).get("/api/ruta-que-no-existe")).status).toBe(404);
  });
});

describe("Criterio 3: derecho de supresión", () => {
  test("no deja irse al único propietario de un comercio", async () => {
    // Dejaría al comercio sin nadie que pueda administrarlo.
    const respuesta = await request(app)
      .delete("/api/mi-cuenta")
      .set("Cookie", dueno.cookie);

    expect(respuesta.status).toBe(409);
    expect(respuesta.body.error).toMatch(/único propietario/i);
  });

  test("anonimiza los datos y deja la cuenta inutilizable", async () => {
    const socio = await registrar("socio");

    // Para poder irse tiene que quedar otro propietario en su comercio. Se lo
    // suma directo a `member` porque el alta de miembros es de HU-4, que
    // todavía no está en esta rama; lo que se prueba acá es la baja, no la
    // invitación.
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: socio.organizationId,
      userId: dueno.id,
      role: "propietario",
      createdAt: new Date(),
    });

    const baja = await request(app)
      .delete("/api/mi-cuenta")
      .set("Cookie", socio.cookie);

    expect(baja.status).toBe(204);

    // El nombre y el correo ya no identifican a nadie.
    const [despues] = await db
      .select({ nombre: user.name, correo: user.email })
      .from(user)
      .where(eq(user.id, socio.id));

    expect(despues.nombre).toBe("Usuario eliminado");
    expect(despues.correo).not.toBe(socio.email);
    expect(despues.correo).toMatch(/@invalido\.local$/);

    // Las credenciales y las sesiones se borraron de verdad.
    const credenciales = await db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.userId, socio.id));

    const sesiones = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, socio.id));

    expect(credenciales).toHaveLength(0);
    expect(sesiones).toHaveLength(0);
  });

  test("después de la baja no se puede volver a entrar", async () => {
    const respuesta = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: correoDe("socio"), password: PASSWORD });

    expect(respuesta.status).toBe(401);
  });

  test("sin sesión responde 401", async () => {
    expect((await request(app).delete("/api/mi-cuenta")).status).toBe(401);
  });
});
