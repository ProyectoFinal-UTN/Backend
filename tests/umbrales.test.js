import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, user } from "../src/db/schema.js";

/**
 * Test de integracion de HU-16 (umbral minimo de reposicion, SCRUM-124).
 *
 * Corre contra la base real, como tests/productos.test.js: lo que importa es
 * que el umbral se guarde, que un dato invalido no lo pise y que un comercio
 * no pueda leer ni tocar el de otro, y eso solo se prueba con sesiones y
 * filas de verdad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu16-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";
const ID_INEXISTENTE = "123e4567-e89b-12d3-a456-426614174000";

let contadorCodigo = 0;
/** Codigo de barras unico por test, para no chocar entre corridas. */
function codigoBarras() {
  contadorCodigo += 1;
  return `77916${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
}

/** Registra un comercio nuevo y devuelve su cookie de sesion. */
async function registrarComercio(etiqueta) {
  const email = correo(etiqueta);

  const respuesta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: `Comercio ${etiqueta}`, email, password: PASSWORD });

  expect(respuesta.status).toBe(200);

  const cookie = (respuesta.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");

  return { email, cookie };
}

async function crearProducto(cookie, umbralMinimo = 0) {
  const respuesta = await request(app)
    .post("/api/productos")
    .set("Cookie", cookie)
    .send({
      nombre: "Yerba 1kg",
      codigoBarras: codigoBarras(),
      categoria: "Almacén",
      unidadMedida: "unidad",
      umbralMinimo,
      stockActual: 0,
    });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

const leerUmbral = (cookie, id) =>
  request(app).get(`/api/productos/${id}/umbral`).set("Cookie", cookie);

const cambiarUmbral = (cookie, id, body) =>
  request(app).put(`/api/productos/${id}/umbral`).set("Cookie", cookie).send(body);

let comercioA;
let comercioB;

beforeAll(async () => {
  comercioA = await registrarComercio("a");
  comercioB = await registrarComercio("b");
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // El comercio va antes que el usuario, por el mismo motivo que en
  // tests/productos.test.js: se lleva por cascada productos y stock.
  if (ids.length > 0) {
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

describe("Sin sesión", () => {
  test("GET y PUT del umbral responden 401", async () => {
    const lectura = await request(app).get(`/api/productos/${ID_INEXISTENTE}/umbral`);
    const cambio = await request(app)
      .put(`/api/productos/${ID_INEXISTENTE}/umbral`)
      .send({ umbralMinimo: 10 });

    expect(lectura.status).toBe(401);
    expect(cambio.status).toBe(401);
  });
});

describe("Alta y modificación del umbral", () => {
  test("un producto sin umbral configurado lo tiene en 0 y se le puede guardar uno", async () => {
    const creado = await crearProducto(comercioA.cookie, 0);

    const antes = await leerUmbral(comercioA.cookie, creado.id);
    expect(antes.status).toBe(200);
    expect(antes.body).toEqual({ productoId: creado.id, umbralMinimo: 0 });

    const alta = await cambiarUmbral(comercioA.cookie, creado.id, { umbralMinimo: 10 });
    expect(alta.status).toBe(200);
    expect(alta.body).toEqual({ productoId: creado.id, umbralMinimo: 10 });

    const despues = await leerUmbral(comercioA.cookie, creado.id);
    expect(despues.body.umbralMinimo).toBe(10);
  });

  test("se modifica un umbral ya configurado y se lee el valor nuevo", async () => {
    const creado = await crearProducto(comercioA.cookie, 5);

    const cambio = await cambiarUmbral(comercioA.cookie, creado.id, { umbralMinimo: 20 });
    expect(cambio.status).toBe(200);
    expect(cambio.body.umbralMinimo).toBe(20);

    expect((await leerUmbral(comercioA.cookie, creado.id)).body.umbralMinimo).toBe(20);

    // El detalle del producto (HU-9/HU-11) ve el mismo valor.
    const detalle = await request(app)
      .get(`/api/productos/${creado.id}`)
      .set("Cookie", comercioA.cookie);
    expect(detalle.body.umbralMinimo).toBe(20);
  });

  test("se puede volver a 0 para quitar el umbral", async () => {
    const creado = await crearProducto(comercioA.cookie, 8);

    const cambio = await cambiarUmbral(comercioA.cookie, creado.id, { umbralMinimo: 0 });
    expect(cambio.status).toBe(200);
    expect(cambio.body.umbralMinimo).toBe(0);
  });

  test("solo cambia el umbral: los otros campos del body se ignoran", async () => {
    const creado = await crearProducto(comercioA.cookie, 3);

    const cambio = await cambiarUmbral(comercioA.cookie, creado.id, {
      umbralMinimo: 7,
      nombre: "Otro nombre",
    });
    expect(cambio.status).toBe(200);

    const detalle = await request(app)
      .get(`/api/productos/${creado.id}`)
      .set("Cookie", comercioA.cookie);
    expect(detalle.body.nombre).toBe("Yerba 1kg");
    expect(detalle.body.umbralMinimo).toBe(7);
  });
});

describe("Valores inválidos", () => {
  let productoA;

  beforeAll(async () => {
    productoA = await crearProducto(comercioA.cookie, 4);
  });

  test.each([
    ["negativo", { umbralMinimo: -1 }],
    ["decimal", { umbralMinimo: 2.5 }],
    ["texto", { umbralMinimo: "abc" }],
    ["número como texto", { umbralMinimo: "10" }],
    ["null", { umbralMinimo: null }],
    ["fuera del rango de la columna", { umbralMinimo: 2147483648 }],
    ["body vacío", {}],
  ])("%s → 400 con mensaje, y el umbral no cambia", async (_caso, body) => {
    const respuesta = await cambiarUmbral(comercioA.cookie, productoA.id, body);

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/umbral mínimo/i);
    expect((await leerUmbral(comercioA.cookie, productoA.id)).body.umbralMinimo).toBe(4);
  });

  test("un PUT sin body → 400, y el umbral no cambia", async () => {
    const respuesta = await request(app)
      .put(`/api/productos/${productoA.id}/umbral`)
      .set("Cookie", comercioA.cookie);

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/umbral mínimo/i);
    expect((await leerUmbral(comercioA.cookie, productoA.id)).body.umbralMinimo).toBe(4);
  });
});

describe("Producto inexistente", () => {
  test.each([
    ["un UUID que no existe", ID_INEXISTENTE],
    ["un id que no es UUID", "no-es-un-uuid"],
  ])("%s → 404 en GET y en PUT", async (_caso, id) => {
    expect((await leerUmbral(comercioA.cookie, id)).status).toBe(404);
    expect((await cambiarUmbral(comercioA.cookie, id, { umbralMinimo: 1 })).status).toBe(404);
  });

  test("un producto dado de baja → 404 en GET y en PUT", async () => {
    const creado = await crearProducto(comercioA.cookie, 2);
    await request(app).delete(`/api/productos/${creado.id}`).set("Cookie", comercioA.cookie);

    expect((await leerUmbral(comercioA.cookie, creado.id)).status).toBe(404);
    expect((await cambiarUmbral(comercioA.cookie, creado.id, { umbralMinimo: 1 })).status).toBe(404);
  });
});

describe("Aislamiento entre comercios (multi-tenant)", () => {
  test("otro comercio recibe 404 en GET y en PUT, igual que con un id inexistente, y el umbral no cambia", async () => {
    const deA = await crearProducto(comercioA.cookie, 6);

    const lectura = await leerUmbral(comercioB.cookie, deA.id);
    expect(lectura.status).toBe(404);
    expect(lectura.body).toEqual({ error: "El producto no existe" });

    const cambio = await cambiarUmbral(comercioB.cookie, deA.id, { umbralMinimo: 99 });
    expect(cambio.status).toBe(404);
    expect(cambio.body).toEqual({ error: "El producto no existe" });

    expect((await leerUmbral(comercioA.cookie, deA.id)).body.umbralMinimo).toBe(6);
  });
});

describe("Restricciones por rol", () => {
  test("un empleado puede leer el umbral pero no cambiarlo", async () => {
    const empleado = await registrarComercio("empleado");
    // Se crea mientras todavia es propietario: como empleado ya no podria.
    const suyo = await crearProducto(empleado.cookie, 3);

    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, empleado.email));

    await db.update(member).set({ role: "empleado" }).where(eq(member.userId, fila.id));

    const lectura = await leerUmbral(empleado.cookie, suyo.id);
    expect(lectura.status).toBe(200);
    expect(lectura.body.umbralMinimo).toBe(3);

    const cambio = await cambiarUmbral(empleado.cookie, suyo.id, { umbralMinimo: 50 });
    expect(cambio.status).toBe(403);

    expect((await leerUmbral(empleado.cookie, suyo.id)).body.umbralMinimo).toBe(3);
  });
});
