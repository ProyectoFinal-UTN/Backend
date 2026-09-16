import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, user } from "../src/db/schema.js";

/**
 * Test de integracion de HU-8 (configuracion general del negocio).
 *
 * Corre contra la base real: lo que se verifica es el filtrado por
 * `comercio_id` y las restricciones por rol, que solo tienen sentido con datos
 * y sesiones de verdad.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu8-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

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

let propietarioA;
let propietarioB;

beforeAll(async () => {
  propietarioA = await registrarComercio("a");
  propietarioB = await registrarComercio("b");
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // El comercio va primero, antes que el usuario: `movimiento.usuario_id` es
  // `onDelete: restrict` (HU-13), asi que borrar un usuario que registro
  // movimientos falla mientras esas filas existan. Borrar el comercio se las
  // lleva por cascada junto con `ubicacion`.
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
  test("no se puede listar ubicaciones", async () => {
    const respuesta = await request(app).get("/api/ubicaciones");
    expect(respuesta.status).toBe(401);
  });

  test("no se puede leer la configuración", async () => {
    const respuesta = await request(app).get("/api/configuracion");
    expect(respuesta.status).toBe(401);
  });
});

describe("Ubicaciones de stock", () => {
  test("un comercio nuevo arranca sin ubicaciones", async () => {
    const respuesta = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual([]);
  });

  test("el propietario define sus ubicaciones", async () => {
    for (const nombre of ["Depósito", "Local"]) {
      const respuesta = await request(app)
        .post("/api/ubicaciones")
        .set("Cookie", propietarioA.cookie)
        .send({ nombre });

      expect(respuesta.status).toBe(201);
      expect(respuesta.body.nombre).toBe(nombre);
      expect(respuesta.body.id).toBeTruthy();
    }

    const listado = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie);

    // Ordenadas por nombre.
    expect(listado.body.map((u) => u.nombre)).toEqual(["Depósito", "Local"]);
  });

  test("recorta los espacios del nombre", async () => {
    const respuesta = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "   Vidriera   " });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.nombre).toBe("Vidriera");
  });

  test("rechaza un nombre vacío", async () => {
    const respuesta = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "   " });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/obligatorio/i);
  });

  test("rechaza un nombre repetido en el mismo comercio", async () => {
    const respuesta = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Local" });

    expect(respuesta.status).toBe(409);
    expect(respuesta.body.error).toMatch(/ya existe/i);
  });

  test("dos altas simultáneas del mismo nombre no rompen con 500", async () => {
    // El chequeo previo de duplicados tiene una ventana entre el SELECT y el
    // INSERT: dos pedidos a la vez la atraviesan y chocan contra el unique.
    // Una tiene que crear y la otra recibir 409, nunca un 500.
    const [una, otra] = await Promise.all([
      request(app)
        .post("/api/ubicaciones")
        .set("Cookie", propietarioA.cookie)
        .send({ nombre: "Simultanea" }),
      request(app)
        .post("/api/ubicaciones")
        .set("Cookie", propietarioA.cookie)
        .send({ nombre: "Simultanea" }),
    ]);

    const codigos = [una.status, otra.status].sort();
    expect(codigos).toEqual([201, 409]);
  });

  test("rechaza un nombre más largo que el máximo, tanto al crear como al renombrar", async () => {
    const largo = "x".repeat(101);

    const alCrear = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: largo });

    expect(alCrear.status).toBe(400);

    const creada = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Para renombrar largo" });

    const alRenombrar = await request(app)
      .put(`/api/ubicaciones/${creada.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: largo });

    // Antes esto reventaba con 500 porque solo el POST validaba el largo.
    expect(alRenombrar.status).toBe(400);
  });

  test("un id que no es UUID devuelve 404, no 500", async () => {
    const borrado = await request(app)
      .delete("/api/ubicaciones/no-es-un-uuid")
      .set("Cookie", propietarioA.cookie);

    expect(borrado.status).toBe(404);

    const renombrado = await request(app)
      .put("/api/ubicaciones/12345")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Cualquiera" });

    expect(renombrado.status).toBe(404);
  });

  test("renombra una ubicación existente", async () => {
    const creada = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Altillo" });

    const renombrada = await request(app)
      .put(`/api/ubicaciones/${creada.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Entrepiso" });

    expect(renombrada.status).toBe(200);
    expect(renombrada.body.nombre).toBe("Entrepiso");
  });

  test("elimina una ubicación", async () => {
    const creada = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Temporal" });

    const borrada = await request(app)
      .delete(`/api/ubicaciones/${creada.body.id}`)
      .set("Cookie", propietarioA.cookie);

    expect(borrada.status).toBe(204);

    const repetida = await request(app)
      .delete(`/api/ubicaciones/${creada.body.id}`)
      .set("Cookie", propietarioA.cookie);

    expect(repetida.status).toBe(404);
  });

  test("no elimina una ubicación que tiene movimientos registrados (HU-13)", async () => {
    const propietario = await registrarComercio("ubicacion-con-movimientos");

    // El alta del producto crea la ubicación "Principal" y su movimiento de
    // stock inicial, que es justamente lo que debe bloquear el borrado.
    const producto = await request(app)
      .post("/api/productos")
      .set("Cookie", propietario.cookie)
      .send({
        nombre: "Producto con historial",
        codigoBarras: `7891${Date.now().toString().slice(-9)}`,
        categoria: "Bebidas",
        unidadMedida: "unidad",
        umbralMinimo: 1,
        stockActual: 5,
      });
    expect(producto.status).toBe(201);

    const borrada = await request(app)
      .delete(`/api/ubicaciones/${producto.body.stock.ubicacionId}`)
      .set("Cookie", propietario.cookie);

    expect(borrada.status).toBe(409);
    expect(borrada.body.error).toMatch(/movimientos/i);
  });
});

describe("Aislamiento entre comercios (multi-tenant)", () => {
  test("cada comercio ve solo sus ubicaciones", async () => {
    await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioB.cookie)
      .send({ nombre: "Sucursal Centro" });

    const deB = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioB.cookie);

    expect(deB.body.map((u) => u.nombre)).toEqual(["Sucursal Centro"]);

    const deA = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie);

    expect(deA.body.map((u) => u.nombre)).not.toContain("Sucursal Centro");
  });

  test("el mismo nombre puede repetirse en comercios distintos", async () => {
    const respuesta = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", propietarioB.cookie)
      .send({ nombre: "Local" }); // ya existe en el comercio A

    expect(respuesta.status).toBe(201);
  });

  test("un comercio no puede borrar la ubicación de otro", async () => {
    const deB = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioB.cookie);

    const ajena = deB.body[0];

    const intento = await request(app)
      .delete(`/api/ubicaciones/${ajena.id}`)
      .set("Cookie", propietarioA.cookie);

    // 404 y no 403: para el comercio A esa ubicación simplemente no existe.
    expect(intento.status).toBe(404);

    const sigueViva = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioB.cookie);

    expect(sigueViva.body.map((u) => u.id)).toContain(ajena.id);
  });

  test("un comercio no puede renombrar la ubicación de otro", async () => {
    const deB = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioB.cookie);

    const intento = await request(app)
      .put(`/api/ubicaciones/${deB.body[0].id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Robada" });

    expect(intento.status).toBe(404);
  });
});

describe("Configuración general", () => {
  test("devuelve moneda y ubicaciones juntas", async () => {
    const respuesta = await request(app)
      .get("/api/configuracion")
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.moneda).toBe("ARS");
    expect(Array.isArray(respuesta.body.ubicaciones)).toBe(true);
  });

  test("el propietario cambia la moneda", async () => {
    const respuesta = await request(app)
      .put("/api/configuracion/moneda")
      .set("Cookie", propietarioA.cookie)
      .send({ moneda: "usd" });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.moneda).toBe("USD");

    const config = await request(app)
      .get("/api/configuracion")
      .set("Cookie", propietarioA.cookie);

    expect(config.body.moneda).toBe("USD");
  });

  test("rechaza una moneda que no está en la lista", async () => {
    const respuesta = await request(app)
      .put("/api/configuracion/moneda")
      .set("Cookie", propietarioA.cookie)
      .send({ moneda: "XYZ" });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/inválida/i);
  });
});

describe("Creación directa de organizaciones", () => {
  test("está cerrada, para que nadie se rompa su propia cuenta", async () => {
    // El plugin de Better Auth expone este endpoint y por defecto lo permite.
    // La organización nacería sin fila en `comercio` y quedaría activa, con lo
    // cual requireAuth pasaría a responder 403 en todos los endpoints.
    const respuesta = await request(app)
      .post("/api/auth/organization/create")
      .set("Cookie", propietarioA.cookie)
      .send({ name: "Comercio paralelo", slug: `paralelo-${SUFIJO}` });

    expect(respuesta.status).toBeGreaterThanOrEqual(400);

    // Y el comercio original sigue funcionando.
    const sigueAndando = await request(app)
      .get("/api/configuracion")
      .set("Cookie", propietarioA.cookie);

    expect(sigueAndando.status).toBe(200);
  });
});

describe("Restricciones por rol", () => {
  test("un empleado puede leer pero no crear ubicaciones", async () => {
    const empleado = await registrarComercio("empleado");

    // Se le baja el rol directamente en la base: la gestión de roles es HU-4.
    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, empleado.email));

    await db
      .update(member)
      .set({ role: "empleado" })
      .where(eq(member.userId, fila.id));

    const lectura = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", empleado.cookie);

    expect(lectura.status).toBe(200);

    const escritura = await request(app)
      .post("/api/ubicaciones")
      .set("Cookie", empleado.cookie)
      .send({ nombre: "No debería entrar" });

    expect(escritura.status).toBe(403);

    const moneda = await request(app)
      .put("/api/configuracion/moneda")
      .set("Cookie", empleado.cookie)
      .send({ moneda: "USD" });

    expect(moneda.status).toBe(403);
  });
});
