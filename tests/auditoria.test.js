import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, user } from "../src/db/schema.js";
import { interpretarRuta } from "../src/middlewares/auditoria.middleware.js";

/**
 * Test de integracion de HU-5 (auditoria de accesos).
 *
 * Corre contra la base real: lo que importa verificar es que el registro se
 * llene solo cuando ocurren cosas, y que ningun rol que no sea propietario
 * pueda leerlo.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = "unaClaveSegura123";

const correoDe = (etiqueta) => `test-hu5-${etiqueta}-${SUFIJO}@test.local`;

function cookiesDe(respuesta) {
  return (respuesta.headers["set-cookie"] ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function registrar(etiqueta) {
  const email = correoDe(etiqueta);

  const alta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: etiqueta, email, password: PASSWORD });

  if (alta.status !== 200) {
    throw new Error(`No se pudo registrar a ${etiqueta}: ${alta.status}`);
  }

  return { email, cookie: cookiesDe(alta) };
}

/** Espera a que la auditoria registre, que ocurre despues de la respuesta. */
async function esperarRegistro(cookie, condicion, intentos = 20) {
  for (let i = 0; i < intentos; i += 1) {
    const respuesta = await request(app)
      .get("/api/auditoria")
      .set("Cookie", cookie);

    const encontrado = (respuesta.body.eventos ?? []).find(condicion);

    if (encontrado) {
      return encontrado;
    }

    await new Promise((resolver) => setTimeout(resolver, 150));
  }

  return null;
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

  // El comercio primero: se lleva por cascada la auditoria y las ubicaciones.
  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

describe("interpretarRuta", () => {
  test("deduce el recurso en singular", () => {
    expect(interpretarRuta("/api/productos")).toMatchObject({
      recurso: "producto",
      recursoId: null,
    });
  });

  test("separa el id del recurso", () => {
    const ruta = interpretarRuta(
      "/api/ubicaciones/3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    );

    expect(ruta.recurso).toBe("ubicacion");
    expect(ruta.recursoId).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  test("no confunde una subruta con un id", () => {
    const ruta = interpretarRuta("/api/miembros/invitaciones");

    expect(ruta.recurso).toBe("miembro");
    expect(ruta.recursoId).toBeNull();
    expect(ruta.detalle).toBe("invitaciones");
  });

  test("ignora la query string", () => {
    expect(interpretarRuta("/api/productos?buscar=agua").recurso).toBe(
      "producto",
    );
  });
});

describe("Registro de accesos", () => {
  test("el alta deja constancia del acceso, con fecha y usuario", async () => {
    const acceso = await esperarRegistro(
      dueno.cookie,
      (evento) => evento.accion === "inicio_sesion",
    );

    expect(acceso).not.toBeNull();
    expect(acceso.recurso).toBe("sesion");
    expect(acceso.usuarioCorreo).toBe(dueno.email);
    expect(new Date(acceso.fecha).getTime()).toBeGreaterThan(0);
  });

  test("iniciar sesión agrega otro acceso", async () => {
    const antes = await request(app)
      .get("/api/auditoria?accion=inicio_sesion")
      .set("Cookie", dueno.cookie);

    await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: dueno.email, password: PASSWORD });

    let despues = antes;

    for (let i = 0; i < 20 && despues.body.eventos.length <= antes.body.eventos.length; i += 1) {
      await new Promise((resolver) => setTimeout(resolver, 150));
      despues = await request(app)
        .get("/api/auditoria?accion=inicio_sesion")
        .set("Cookie", dueno.cookie);
    }

    expect(despues.body.eventos.length).toBeGreaterThan(
      antes.body.eventos.length,
    );
  });
});

describe("Registro de acciones", () => {
  test("crear una ubicación queda registrado", async () => {
    const creada = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", dueno.cookie)
      .send({ nombre: `Depósito ${SUFIJO}` });

    expect(creada.status).toBe(201);

    const evento = await esperarRegistro(
      dueno.cookie,
      (e) => e.accion === "crear" && e.recurso === "ubicacion",
    );

    expect(evento).not.toBeNull();
    expect(evento.usuarioCorreo).toBe(dueno.email);
  });

  test("eliminar queda registrado con el id del recurso", async () => {
    const creada = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", dueno.cookie)
      .send({ nombre: `Temporal ${SUFIJO}` });

    await request(app)
      .delete(`/api/ubicaciones/${creada.body.id}`)
      .set("Cookie", dueno.cookie);

    const evento = await esperarRegistro(
      dueno.cookie,
      (e) => e.accion === "eliminar" && e.recursoId === creada.body.id,
    );

    expect(evento).not.toBeNull();
    expect(evento.recurso).toBe("ubicacion");
  });

  test("las consultas no dejan rastro", async () => {
    // Un GET no cambia nada; registrarlo solo ensuciaría el libro.
    await request(app).get("/api/ubicaciones").set("Cookie", dueno.cookie);

    const respuesta = await request(app)
      .get("/api/auditoria")
      .set("Cookie", dueno.cookie);

    const lecturas = respuesta.body.eventos.filter((e) =>
      ["leer", "consultar", "GET"].includes(e.accion),
    );

    expect(lecturas).toHaveLength(0);
  });

  test("un intento rechazado no se registra como acción hecha", async () => {
    // Nombre vacío: el backend responde 400 y no cambió nada.
    await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", dueno.cookie)
      .send({ nombre: "   " });

    await new Promise((resolver) => setTimeout(resolver, 400));

    const respuesta = await request(app)
      .get("/api/auditoria?accion=crear&recurso=ubicacion")
      .set("Cookie", dueno.cookie);

    // Solo están las dos que sí se crearon en los tests de arriba.
    expect(respuesta.body.eventos.length).toBe(2);
  });
});

describe("Filtros", () => {
  test("filtra por acción", async () => {
    const respuesta = await request(app)
      .get("/api/auditoria?accion=inicio_sesion")
      .set("Cookie", dueno.cookie);

    expect(respuesta.status).toBe(200);
    expect(
      respuesta.body.eventos.every((e) => e.accion === "inicio_sesion"),
    ).toBe(true);
  });

  test("ofrece las opciones que existen para filtrar", async () => {
    const respuesta = await request(app)
      .get("/api/auditoria")
      .set("Cookie", dueno.cookie);

    expect(respuesta.body.filtros.acciones).toContain("inicio_sesion");
    expect(respuesta.body.filtros.recursos).toContain("ubicacion");
  });

  test("los eventos vienen del más nuevo al más viejo", async () => {
    const respuesta = await request(app)
      .get("/api/auditoria")
      .set("Cookie", dueno.cookie);

    const fechas = respuesta.body.eventos.map((e) =>
      new Date(e.fecha).getTime(),
    );

    expect(fechas).toEqual([...fechas].sort((a, b) => b - a));
  });
});

describe("Solo el propietario ve la auditoría", () => {
  test("un empleado recibe 403", async () => {
    const empleado = await registrar("empleado");

    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, empleado.email));

    await db
      .update(member)
      .set({ role: "empleado" })
      .where(eq(member.userId, fila.id));

    const respuesta = await request(app)
      .get("/api/auditoria")
      .set("Cookie", empleado.cookie);

    expect(respuesta.status).toBe(403);
  });

  test("un gerente también recibe 403", async () => {
    const gerente = await registrar("gerente");

    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, gerente.email));

    await db
      .update(member)
      .set({ role: "gerente" })
      .where(eq(member.userId, fila.id));

    const respuesta = await request(app)
      .get("/api/auditoria")
      .set("Cookie", gerente.cookie);

    expect(respuesta.status).toBe(403);
  });

  test("sin sesión responde 401", async () => {
    expect((await request(app).get("/api/auditoria")).status).toBe(401);
  });
});

describe("Aislamiento entre comercios", () => {
  test("cada propietario ve solo los eventos de su comercio", async () => {
    const otro = await registrar("otro");

    await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", otro.cookie)
      .send({ nombre: "Sucursal ajena" });

    await esperarRegistro(
      otro.cookie,
      (e) => e.accion === "crear" && e.recurso === "ubicacion",
    );

    const mios = await request(app)
      .get("/api/auditoria")
      .set("Cookie", dueno.cookie);

    expect(
      mios.body.eventos.every((e) => e.usuarioCorreo !== otro.email),
    ).toBe(true);
  });
});
