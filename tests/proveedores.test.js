import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  comercio,
  member,
  organization,
  proveedor,
  stock,
  user,
} from "../src/db/schema.js";

/**
 * Test de integracion de HU-19 (alta y gestion de proveedores).
 *
 * Corre contra la base real, igual que tests/productos.test.js: lo que se
 * verifica es el filtrado por `comercio_id`, el unique parcial del nombre y la
 * FK de `movimiento.proveedor_id`, y nada de eso tiene sentido sin datos de
 * verdad. Que rol puede que cosa lo cubre la matriz de
 * tests/controlAcceso.test.js.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu19-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";
const ID_INEXISTENTE = "123e4567-e89b-12d3-a456-426614174000";

let contador = 0;
/** Nombre unico por test, para que los 409 de un test no choquen con otro. */
function nombreUnico(base = "Proveedor") {
  contador += 1;
  return `${base} ${contador}`;
}

function codigoBarras() {
  contador += 1;
  return `77900${Date.now().toString().slice(-6)}${contador}`.slice(0, 13);
}

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

function crear(cookie, datos) {
  return request(app).post("/api/proveedores").set("Cookie", cookie).send(datos);
}

function listar(cookie) {
  return request(app).get("/api/proveedores").set("Cookie", cookie);
}

function obtener(cookie, id) {
  return request(app).get(`/api/proveedores/${id}`).set("Cookie", cookie);
}

function editar(cookie, id, datos) {
  return request(app)
    .put(`/api/proveedores/${id}`)
    .set("Cookie", cookie)
    .send(datos);
}

function eliminar(cookie, id) {
  return request(app).delete(`/api/proveedores/${id}`).set("Cookie", cookie);
}

async function crearProveedor(cookie, datos = {}) {
  const respuesta = await crear(cookie, { nombre: nombreUnico(), ...datos });
  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

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

  // El comercio va primero, igual que en tests/productos.test.js: se lleva por
  // cascada sus proveedores y movimientos, y recien ahi se puede borrar al
  // usuario (`movimiento.usuario_id` es restrict).
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
  test("no se puede acceder a ninguna ruta de proveedores", async () => {
    expect((await request(app).get("/api/proveedores")).status).toBe(401);
    expect((await request(app).get(`/api/proveedores/${ID_INEXISTENTE}`)).status).toBe(401);
    expect((await request(app).post("/api/proveedores").send({ nombre: "X" })).status).toBe(401);
    expect((await request(app).put(`/api/proveedores/${ID_INEXISTENTE}`).send({})).status).toBe(401);
    expect((await request(app).delete(`/api/proveedores/${ID_INEXISTENTE}`)).status).toBe(401);
  });
});

describe("Alta", () => {
  test("carga nombre, contacto, rubro y condiciones de pago", async () => {
    const datos = {
      nombre: nombreUnico("Distribuidora Sur"),
      contacto: "Laura Gómez",
      telefono: "11 5555-0000",
      correo: "ventas@distrisur.com",
      rubro: "Bebidas",
      condicionesPago: "30 días",
    };

    const respuesta = await crear(comercioA.cookie, datos);

    expect(respuesta.status).toBe(201);
    expect(respuesta.body).toMatchObject(datos);
    expect(respuesta.body.id).toBeTruthy();
    // Los datos internos no salen en la respuesta.
    expect(respuesta.body).not.toHaveProperty("comercioId");
    expect(respuesta.body).not.toHaveProperty("activo");
  });

  test("con solo el nombre alcanza", async () => {
    const respuesta = await crear(comercioA.cookie, { nombre: nombreUnico() });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.contacto).toBeNull();
    expect(respuesta.body.condicionesPago).toBeNull();
  });

  test("queda en el comercio de la sesión, aunque el body diga otro", async () => {
    const respuesta = await crear(comercioA.cookie, {
      nombre: nombreUnico(),
      comercioId: ID_INEXISTENTE,
    });

    expect(respuesta.status).toBe(201);

    const [fila] = await db
      .select({ comercioId: proveedor.comercioId })
      .from(proveedor)
      .where(eq(proveedor.id, respuesta.body.id));

    expect(fila.comercioId).not.toBe(ID_INEXISTENTE);
    expect((await obtener(comercioA.cookie, respuesta.body.id)).status).toBe(200);
  });

  test("sin nombre responde 400", async () => {
    const respuesta = await crear(comercioA.cookie, { rubro: "Bebidas" });

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/nombre/i);
  });

  test("un correo inválido responde 400", async () => {
    const respuesta = await crear(comercioA.cookie, {
      nombre: nombreUnico(),
      correo: "no-es-un-correo",
    });

    expect(respuesta.status).toBe(400);
  });

  test("un nombre repetido en el mismo comercio responde 409, sin distinguir mayúsculas", async () => {
    const nombre = nombreUnico("Mayorista Norte");
    await crearProveedor(comercioA.cookie, { nombre });

    const repetido = await crear(comercioA.cookie, {
      nombre: nombre.toUpperCase(),
    });

    expect(repetido.status).toBe(409);
    expect(repetido.body.error).toMatch(/ya existe/i);
  });

  test("el mismo nombre en otro comercio no choca", async () => {
    const nombre = nombreUnico("Compartido");
    await crearProveedor(comercioA.cookie, { nombre });

    const enB = await crear(comercioB.cookie, { nombre });

    expect(enB.status).toBe(201);
  });
});

describe("Listado y consulta", () => {
  test("lista solo los del comercio, ordenados por nombre", async () => {
    const zeta = await crearProveedor(comercioA.cookie, { nombre: nombreUnico("Zeta") });
    const alfa = await crearProveedor(comercioA.cookie, { nombre: nombreUnico("Alfa") });
    const deB = await crearProveedor(comercioB.cookie);

    const respuesta = await listar(comercioA.cookie);

    expect(respuesta.status).toBe(200);
    const ids = respuesta.body.map((p) => p.id);
    expect(ids).toContain(zeta.id);
    expect(ids).toContain(alfa.id);
    expect(ids).not.toContain(deB.id);
    expect(ids.indexOf(alfa.id)).toBeLessThan(ids.indexOf(zeta.id));
  });

  test("obtiene un proveedor propio por id", async () => {
    const creado = await crearProveedor(comercioA.cookie, { rubro: "Limpieza" });

    const respuesta = await obtener(comercioA.cookie, creado.id);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toMatchObject({ id: creado.id, rubro: "Limpieza" });
  });

  test("el proveedor de otro comercio responde 404, igual que uno inexistente", async () => {
    const deB = await crearProveedor(comercioB.cookie);

    const ajeno = await obtener(comercioA.cookie, deB.id);
    const inexistente = await obtener(comercioA.cookie, ID_INEXISTENTE);

    expect(ajeno.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(ajeno.body).toEqual(inexistente.body);
  });

  test("un id que no es UUID responde 404 y no 500", async () => {
    expect((await obtener(comercioA.cookie, "no-es-uuid")).status).toBe(404);
  });
});

describe("Edición", () => {
  test("modifica solo los campos enviados", async () => {
    const creado = await crearProveedor(comercioA.cookie, {
      contacto: "Pedro",
      rubro: "Bebidas",
    });

    const respuesta = await editar(comercioA.cookie, creado.id, {
      condicionesPago: "Contado",
    });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toMatchObject({
      contacto: "Pedro",
      rubro: "Bebidas",
      condicionesPago: "Contado",
    });
  });

  test("null borra un dato opcional", async () => {
    const creado = await crearProveedor(comercioA.cookie, { telefono: "1234" });

    const respuesta = await editar(comercioA.cookie, creado.id, { telefono: null });

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.telefono).toBeNull();
  });

  test("sin campos responde 400", async () => {
    const creado = await crearProveedor(comercioA.cookie);

    expect((await editar(comercioA.cookie, creado.id, {})).status).toBe(400);
  });

  test("renombrar a un nombre que ya usa otro proveedor responde 409", async () => {
    const uno = await crearProveedor(comercioA.cookie);
    const otro = await crearProveedor(comercioA.cookie);

    const respuesta = await editar(comercioA.cookie, otro.id, { nombre: uno.nombre });

    expect(respuesta.status).toBe(409);
  });

  test("conservar el propio nombre no choca consigo mismo", async () => {
    const creado = await crearProveedor(comercioA.cookie);

    const respuesta = await editar(comercioA.cookie, creado.id, {
      nombre: creado.nombre,
      rubro: "Otro",
    });

    expect(respuesta.status).toBe(200);
  });

  test("no se puede editar el proveedor de otro comercio", async () => {
    const deB = await crearProveedor(comercioB.cookie, { rubro: "Original" });

    const respuesta = await editar(comercioA.cookie, deB.id, { rubro: "Pisado" });

    expect(respuesta.status).toBe(404);
    expect((await obtener(comercioB.cookie, deB.id)).body.rubro).toBe("Original");
  });
});

describe("Baja", () => {
  test("deja de aparecer en el listado y en la consulta", async () => {
    const creado = await crearProveedor(comercioA.cookie);

    const respuesta = await eliminar(comercioA.cookie, creado.id);

    expect(respuesta.status).toBe(204);
    expect((await listar(comercioA.cookie)).body.map((p) => p.id)).not.toContain(
      creado.id,
    );
    expect((await obtener(comercioA.cookie, creado.id)).status).toBe(404);
    expect((await editar(comercioA.cookie, creado.id, { rubro: "X" })).status).toBe(404);
  });

  test("es lógica: la fila sigue en la base", async () => {
    const creado = await crearProveedor(comercioA.cookie);
    await eliminar(comercioA.cookie, creado.id);

    const [fila] = await db
      .select({ activo: proveedor.activo })
      .from(proveedor)
      .where(eq(proveedor.id, creado.id));

    expect(fila.activo).toBe(false);
  });

  test("es idempotente", async () => {
    const creado = await crearProveedor(comercioA.cookie);

    expect((await eliminar(comercioA.cookie, creado.id)).status).toBe(204);
    expect((await eliminar(comercioA.cookie, creado.id)).status).toBe(204);
    expect((await eliminar(comercioA.cookie, "no-es-uuid")).status).toBe(204);
  });

  test("no da de baja el proveedor de otro comercio", async () => {
    const deB = await crearProveedor(comercioB.cookie);

    expect((await eliminar(comercioA.cookie, deB.id)).status).toBe(204);
    expect((await obtener(comercioB.cookie, deB.id)).status).toBe(200);
  });

  test("libera el nombre: se puede volver a cargar", async () => {
    const creado = await crearProveedor(comercioA.cookie);
    await eliminar(comercioA.cookie, creado.id);

    const denuevo = await crear(comercioA.cookie, { nombre: creado.nombre });

    expect(denuevo.status).toBe(201);
    expect(denuevo.body.id).not.toBe(creado.id);
  });
});

describe("Proveedor de un movimiento de compra", () => {
  let productoA;

  beforeAll(async () => {
    const respuesta = await request(app)
      .post("/api/productos")
      .set("Cookie", comercioA.cookie)
      .send({
        nombre: "Yerba 1kg",
        codigoBarras: codigoBarras(),
        categoria: "Almacén",
        unidadMedida: "unidad",
        umbralMinimo: 2,
        stockActual: 10,
      });
    expect(respuesta.status).toBe(201);
    productoA = respuesta.body;
  });

  function comprar(proveedorId) {
    return request(app)
      .post("/api/movimientos")
      .set("Cookie", comercioA.cookie)
      .send({ productoId: productoA.id, tipo: "compra", cantidad: 3, proveedorId });
  }

  async function stockActual() {
    const [fila] = await db
      .select({ cantidad: stock.cantidad })
      .from(stock)
      .where(eq(stock.id, productoA.stock.id));
    return fila.cantidad;
  }

  test("con un proveedor propio, queda registrado", async () => {
    const propio = await crearProveedor(comercioA.cookie);

    const respuesta = await comprar(propio.id);

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.movimiento.proveedorId).toBe(propio.id);
  });

  test.each([
    ["de otro comercio", async () => (await crearProveedor(comercioB.cookie)).id],
    ["inexistente", async () => ID_INEXISTENTE],
    [
      "dado de baja",
      async () => {
        const viejo = await crearProveedor(comercioA.cookie);
        await eliminar(comercioA.cookie, viejo.id);
        return viejo.id;
      },
    ],
  ])("con un proveedor %s responde 404 y no mueve el stock", async (_caso, idDe) => {
    const proveedorId = await idDe();
    const antes = await stockActual();

    const respuesta = await comprar(proveedorId);

    expect(respuesta.status).toBe(404);
    expect(respuesta.body.error).toMatch(/proveedor no existe/i);
    expect(await stockActual()).toBe(antes);
  });

  test("dar de baja al proveedor no le borra las compras del historial", async () => {
    const proveedorViejo = await crearProveedor(comercioA.cookie);
    const compra = await comprar(proveedorViejo.id);
    expect(compra.status).toBe(201);

    expect((await eliminar(comercioA.cookie, proveedorViejo.id)).status).toBe(204);

    const historial = await request(app)
      .get("/api/movimientos")
      .query({ proveedorId: proveedorViejo.id })
      .set("Cookie", comercioA.cookie);

    expect(historial.status).toBe(200);
    expect(historial.body.movimientos.map((m) => m.id)).toEqual([
      compra.body.movimiento.id,
    ]);
  });
});
