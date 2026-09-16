import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  comercio,
  invitation,
  member,
  organization,
  user,
} from "../src/db/schema.js";

/**
 * Test de integracion de HU-4 (gestion de roles y permisos).
 *
 * Corre contra la base real: lo que se verifica son los permisos por rol y el
 * aislamiento entre comercios, que solo tienen sentido con sesiones de verdad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = "unaClaveSegura123";

const correoDe = (etiqueta) => `test-hu4-${etiqueta}-${SUFIJO}@test.local`;

function cookiesDe(respuesta) {
  return (respuesta.headers["set-cookie"] ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Registra a alguien. Con `invitacionId` se suma al comercio que lo invito. */
async function registrar(etiqueta, invitacionId) {
  const email = correoDe(etiqueta);

  const alta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({
      name: etiqueta,
      email,
      password: PASSWORD,
      ...(invitacionId ? { invitacionId } : {}),
    });

  if (alta.status !== 200) {
    throw new Error(`No se pudo registrar a ${etiqueta}: ${alta.status}`);
  }

  return { email, cookie: cookiesDe(alta) };
}

/** Cambia el rol de alguien directo en la base, para armar escenarios. */
async function ponerRol(email, rol) {
  const [fila] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));

  await db.update(member).set({ role: rol }).where(eq(member.userId, fila.id));
}

let dueno;

beforeAll(async () => {
  dueno = await registrar("dueno");
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = [...new Set(creadas.map((fila) => fila.organizationId))];

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(invitation).where(inArray(invitation.organizationId, ids));
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

describe("GET /api/miembros", () => {
  test("el propietario ve el equipo, las invitaciones y los roles", async () => {
    const respuesta = await request(app)
      .get("/api/miembros")
      .set("Cookie", dueno.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.miembros).toHaveLength(1);
    expect(respuesta.body.miembros[0]).toMatchObject({
      correo: dueno.email,
      rol: "propietario",
    });
    expect(respuesta.body.invitaciones).toEqual([]);
    expect(respuesta.body.roles.map((r) => r.id)).toEqual([
      "propietario",
      "gerente",
      "empleado",
    ]);
  });

  test("sin sesion responde 401", async () => {
    expect((await request(app).get("/api/miembros")).status).toBe(401);
  });
});

describe("Invitaciones", () => {
  test("el propietario invita eligiendo el rol", async () => {
    const respuesta = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("invitado"), rol: "empleado" });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.rol).toBe("empleado");
    expect(respuesta.body.id).toBeTruthy();

    // Vence dentro de las 48 horas.
    const horas = (new Date(respuesta.body.venceEl) - Date.now()) / 3_600_000;
    expect(horas).toBeGreaterThan(47);
    expect(horas).toBeLessThanOrEqual(48);
  });

  test("rechaza un rol que no existe", async () => {
    const respuesta = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("x"), rol: "jefe" });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/rol inválido/i);
  });

  test("rechaza invitar a alguien que ya es del comercio", async () => {
    const respuesta = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: dueno.email, rol: "gerente" });

    expect(respuesta.status).toBe(409);
  });

  test("se puede ver sin sesion, para decidir antes de crear la cuenta", async () => {
    const creada = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("mirona"), rol: "gerente" });

    const vista = await request(app).get(
      `/api/invitaciones/${creada.body.id}`,
    );

    expect(vista.status).toBe(200);
    expect(vista.body.rol).toBe("gerente");
    // No se filtra nada del comercio a quien todavia no acepto.
    expect(vista.body.organizationId).toBeUndefined();
  });

  test("una invitacion inexistente da 404", async () => {
    expect((await request(app).get("/api/invitaciones/no-existe")).status).toBe(
      404,
    );
  });

  test("cancelar la deja inutilizable", async () => {
    const creada = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("cancelada"), rol: "empleado" });

    const cancelada = await request(app)
      .delete(`/api/miembros/invitaciones/${creada.body.id}`)
      .set("Cookie", dueno.cookie);

    expect(cancelada.status).toBe(204);

    const vista = await request(app).get(`/api/invitaciones/${creada.body.id}`);
    expect(vista.status).toBe(410);
  });
});

describe("Registrarse desde una invitación", () => {
  test("suma al comercio que invitó y no crea uno propio", async () => {
    const creada = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("nuevo"), rol: "empleado" });

    const invitado = await registrar("nuevo", creada.body.id);

    // Entró al comercio del dueño, con el rol de la invitación.
    const equipo = await request(app)
      .get("/api/miembros")
      .set("Cookie", dueno.cookie);

    const incorporado = equipo.body.miembros.find(
      (m) => m.correo === invitado.email,
    );

    expect(incorporado).toBeDefined();
    expect(incorporado.rol).toBe("empleado");

    // Y no tiene un comercio propio: su única membresía es esta.
    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, invitado.email));

    const membresias = await db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, fila.id));

    expect(membresias).toHaveLength(1);
  });

  test("con una invitación inválida igual queda con su comercio propio", async () => {
    // Mejor eso que una cuenta inservible.
    const invitado = await registrar("invalida", "no-existe-esta");

    const respuesta = await request(app)
      .get("/api/configuracion")
      .set("Cookie", invitado.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.rol).toBe("propietario");
  });
});

describe("Cambio de rol y bajas", () => {
  test("el propietario cambia el rol de otro", async () => {
    const creada = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("ascendido"), rol: "empleado" });

    const otro = await registrar("ascendido", creada.body.id);

    const equipo = await request(app)
      .get("/api/miembros")
      .set("Cookie", dueno.cookie);

    const suMembresia = equipo.body.miembros.find(
      (m) => m.correo === otro.email,
    );

    const cambio = await request(app)
      .put(`/api/miembros/${suMembresia.id}/rol`)
      .set("Cookie", dueno.cookie)
      .send({ rol: "gerente" });

    expect(cambio.status).toBe(200);
    expect(cambio.body.rol).toBe("gerente");
  });

  test("nadie puede cambiarse el rol a sí mismo", async () => {
    // Un propietario que se baja por error se deja afuera sin vuelta atrás.
    const equipo = await request(app)
      .get("/api/miembros")
      .set("Cookie", dueno.cookie);

    const propia = equipo.body.miembros.find((m) => m.correo === dueno.email);

    const intento = await request(app)
      .put(`/api/miembros/${propia.id}/rol`)
      .set("Cookie", dueno.cookie)
      .send({ rol: "empleado" });

    expect(intento.status).toBe(400);
    expect(intento.body.error).toMatch(/vos mismo/i);
  });

  test("no se puede quitar al último propietario", async () => {
    const equipo = await request(app)
      .get("/api/miembros")
      .set("Cookie", dueno.cookie);

    const propia = equipo.body.miembros.find((m) => m.correo === dueno.email);

    const intento = await request(app)
      .delete(`/api/miembros/${propia.id}`)
      .set("Cookie", dueno.cookie);

    // Se corta antes por ser uno mismo, que es el caso más común.
    expect(intento.status).toBe(400);
  });

  test("un miembro de otro comercio no se puede tocar", async () => {
    const ajeno = await registrar("ajeno");

    const suEquipo = await request(app)
      .get("/api/miembros")
      .set("Cookie", ajeno.cookie);

    const suMembresia = suEquipo.body.miembros[0];

    const intento = await request(app)
      .put(`/api/miembros/${suMembresia.id}/rol`)
      .set("Cookie", dueno.cookie)
      .send({ rol: "empleado" });

    // 404 y no 403: para este comercio esa membresía no existe.
    expect(intento.status).toBe(404);
  });
});

describe("Permisos diferenciados por rol", () => {
  test("un empleado no accede a la gestión de usuarios", async () => {
    const creada = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("curioso"), rol: "empleado" });

    const empleado = await registrar("curioso", creada.body.id);

    const lectura = await request(app)
      .get("/api/miembros")
      .set("Cookie", empleado.cookie);

    expect(lectura.status).toBe(403);

    const intento = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", empleado.cookie)
      .send({ correo: correoDe("otro"), rol: "empleado" });

    expect(intento.status).toBe(403);
  });

  test("un gerente ve el equipo pero no invita ni cambia roles", async () => {
    const creada = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", dueno.cookie)
      .send({ correo: correoDe("encargado"), rol: "empleado" });

    const gerente = await registrar("encargado", creada.body.id);
    await ponerRol(gerente.email, "gerente");

    const lectura = await request(app)
      .get("/api/miembros")
      .set("Cookie", gerente.cookie);

    expect(lectura.status).toBe(200);

    const intento = await request(app)
      .post("/api/miembros/invitaciones")
      .set("Cookie", gerente.cookie)
      .send({ correo: correoDe("z"), rol: "empleado" });

    expect(intento.status).toBe(403);
  });
});

describe("El rol viaja en la configuración", () => {
  test("para que la pantalla pueda esconder lo que ese rol no puede usar", async () => {
    const respuesta = await request(app)
      .get("/api/configuracion")
      .set("Cookie", dueno.cookie);

    expect(respuesta.body.rol).toBe("propietario");
  });
});
