import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, user } from "../src/db/schema.js";

/**
 * Test de integracion de HU-6 (alta del perfil del comercio).
 *
 * Corre contra la base real: lo que importa verificar es el filtrado por
 * `comercio_id` y las restricciones por rol, que solo tienen sentido con datos
 * y sesiones de verdad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = "unaClaveSegura123";

function cookiesDe(respuesta) {
  return (respuesta.headers["set-cookie"] ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Registra un comercio nuevo y devuelve su correo y su cookie de sesion. */
async function registrarComercio(etiqueta) {
  const email = `test-hu6-${etiqueta}-${SUFIJO}@test.local`;

  const alta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: `Comercio ${etiqueta}`, email, password: PASSWORD });

  if (alta.status !== 200) {
    throw new Error(`No se pudo crear el comercio de prueba: ${alta.status}`);
  }

  return { email, cookie: cookiesDe(alta) };
}

let propietario;
let otroComercio;

beforeAll(async () => {
  propietario = await registrarComercio("a");
  otroComercio = await registrarComercio("b");
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

describe("GET /api/comercio", () => {
  test("un comercio recien creado trae el nombre por defecto", async () => {
    const respuesta = await request(app)
      .get("/api/comercio")
      .set("Cookie", propietario.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.nombre).toBe("Mi comercio");
    expect(respuesta.body.rubro).toBeNull();
  });

  test("sin sesion responde 401", async () => {
    const respuesta = await request(app).get("/api/comercio");

    expect(respuesta.status).toBe(401);
  });
});

describe("PUT /api/comercio", () => {
  test("guarda los datos del negocio", async () => {
    const respuesta = await request(app)
      .put("/api/comercio")
      .set("Cookie", propietario.cookie)
      .send({
        nombre: "Kiosco Don Pepe",
        rubro: "Kiosco",
        direccion: "Av. Siempreviva 742",
        telefono: "3511234567",
        correoContacto: "donpepe@kiosco.com",
      });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.nombre).toBe("Kiosco Don Pepe");

    // Y persistio de verdad, no solo en la respuesta.
    const releido = await request(app)
      .get("/api/comercio")
      .set("Cookie", propietario.cookie);

    expect(releido.body).toMatchObject({
      nombre: "Kiosco Don Pepe",
      rubro: "Kiosco",
      direccion: "Av. Siempreviva 742",
      correoContacto: "donpepe@kiosco.com",
    });
  });

  test("recorta los espacios de los campos", async () => {
    const respuesta = await request(app)
      .put("/api/comercio")
      .set("Cookie", propietario.cookie)
      .send({ nombre: "   Kiosco   ", rubro: "  Almacén  " });

    expect(respuesta.body.nombre).toBe("Kiosco");
    expect(respuesta.body.rubro).toBe("Almacén");
  });

  test("guarda los opcionales vacios como null y no como cadena vacia", async () => {
    // Asi "sin cargar" se distingue de "cargado en blanco".
    const respuesta = await request(app)
      .put("/api/comercio")
      .set("Cookie", propietario.cookie)
      .send({ nombre: "Kiosco", rubro: "Kiosco", direccion: "   " });

    expect(respuesta.body.direccion).toBeNull();
  });

  test("ignora campos que no son del perfil", async () => {
    // La moneda tiene su propio endpoint (HU-8) y el id no se toca nunca.
    const respuesta = await request(app)
      .put("/api/comercio")
      .set("Cookie", propietario.cookie)
      .send({ nombre: "Kiosco", rubro: "Kiosco", moneda: "USD", id: "otro" });

    expect(respuesta.status).toBe(200);

    const configuracion = await request(app)
      .get("/api/configuracion")
      .set("Cookie", propietario.cookie);

    expect(configuracion.body.moneda).toBe("ARS");
  });
});

describe("Campos obligatorios", () => {
  test.each([
    ["sin nombre", { rubro: "Kiosco" }, /nombre/i],
    ["sin rubro", { nombre: "Kiosco" }, /rubro/i],
    ["nombre en blanco", { nombre: "   ", rubro: "Kiosco" }, /nombre/i],
  ])("rechaza %s", async (_caso, body, mensaje) => {
    const respuesta = await request(app)
      .put("/api/comercio")
      .set("Cookie", propietario.cookie)
      .send(body);

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(mensaje);
  });

  test("rechaza un correo de contacto invalido", async () => {
    const respuesta = await request(app)
      .put("/api/comercio")
      .set("Cookie", propietario.cookie)
      .send({ nombre: "Kiosco", rubro: "Kiosco", correoContacto: "no-es@" });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/correo/i);
  });

  test("rechaza un nombre mas largo que el maximo", async () => {
    const respuesta = await request(app)
      .put("/api/comercio")
      .set("Cookie", propietario.cookie)
      .send({ nombre: "x".repeat(151), rubro: "Kiosco" });

    expect(respuesta.status).toBe(400);
  });
});

describe("Aislamiento entre comercios", () => {
  test("cada uno ve y edita solo su propio perfil", async () => {
    await request(app)
      .put("/api/comercio")
      .set("Cookie", otroComercio.cookie)
      .send({ nombre: "Almacén del Norte", rubro: "Almacén" });

    const deA = await request(app)
      .get("/api/comercio")
      .set("Cookie", propietario.cookie);

    const deB = await request(app)
      .get("/api/comercio")
      .set("Cookie", otroComercio.cookie);

    expect(deB.body.nombre).toBe("Almacén del Norte");
    expect(deA.body.nombre).not.toBe("Almacén del Norte");
  });
});

describe("Restricciones por rol", () => {
  test("un empleado lee el perfil pero no lo modifica", async () => {
    const empleado = await registrarComercio("empleado");

    // Se le baja el rol directamente en la base: la gestion de roles es HU-4.
    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, empleado.email));

    await db
      .update(member)
      .set({ role: "empleado" })
      .where(eq(member.userId, fila.id));

    const lectura = await request(app)
      .get("/api/comercio")
      .set("Cookie", empleado.cookie);

    expect(lectura.status).toBe(200);

    const escritura = await request(app)
      .put("/api/comercio")
      .set("Cookie", empleado.cookie)
      .send({ nombre: "No debería entrar", rubro: "Kiosco" });

    expect(escritura.status).toBe(403);
  });
});
