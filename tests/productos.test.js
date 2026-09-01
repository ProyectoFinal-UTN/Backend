import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, stock, user } from "../src/db/schema.js";

/**
 * Test de integracion de HU-9 (alta, edicion y baja de productos).
 *
 * Corre contra la base real: lo que se verifica es la transaccion
 * producto+stock, el filtrado por `comercio_id` y las restricciones por rol,
 * que solo tienen sentido con datos y sesiones de verdad (mismo criterio que
 * tests/ubicaciones.test.js y tests/registro.test.js).
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu9-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

let contadorCodigo = 0;
/** Codigo de barras unico por test, para no chocar entre corridas. */
function codigoBarras() {
  contadorCodigo += 1;
  return `77900${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
}

function productoValido(overrides = {}) {
  return {
    nombre: "Coca-Cola 500ml",
    codigoBarras: codigoBarras(),
    categoria: "Bebidas",
    unidadMedida: "unidad",
    umbralMinimo: 5,
    stockActual: 20,
    ...overrides,
  };
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

async function crearUbicacionDePrueba(cookie, nombre) {
  const respuesta = await request(app)
    .post("/api/ubicaciones")
    .set("Cookie", cookie)
    .send({ nombre });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
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

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    // `producto`, `ubicacion` y `stock` caen por cascada al borrar su comercio.
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

describe("Sin sesión", () => {
  test("no se puede acceder a ninguna ruta de productos", async () => {
    expect((await request(app).get("/api/productos")).status).toBe(401);
    expect((await request(app).get("/api/productos/algun-id")).status).toBe(401);
    expect((await request(app).post("/api/productos").send(productoValido())).status).toBe(401);
    expect((await request(app).put("/api/productos/algun-id").send({})).status).toBe(401);
    expect((await request(app).delete("/api/productos/algun-id")).status).toBe(401);
  });
});

describe("Alta de productos", () => {
  test("crea el producto y una ubicación 'Principal' cuando el comercio no tiene ninguna", async () => {
    const datos = productoValido();

    const respuesta = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(datos);

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.nombre).toBe(datos.nombre);
    expect(respuesta.body.codigoBarras).toBe(datos.codigoBarras);
    expect(respuesta.body.stock).toMatchObject({ cantidad: datos.stockActual });
    expect(respuesta.body.stock.ubicacionId).toBeTruthy();

    const ubicaciones = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie);

    expect(ubicaciones.body.map((u) => u.nombre)).toContain("Principal");
  });

  test("la fila de stock queda con el comercio_id de la sesión (denormalizado)", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const [filaStock] = await db
      .select({ comercioId: stock.comercioId })
      .from(stock)
      .where(eq(stock.id, creado.body.stock.id));

    const [filaComercio] = await db
      .select({ comercioId: comercio.id })
      .from(comercio)
      .innerJoin(organization, eq(organization.id, comercio.organizationId))
      .innerJoin(member, eq(member.organizationId, organization.id))
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, propietarioA.email));

    expect(filaStock.comercioId).toBe(filaComercio.comercioId);
  });

  test("reutiliza una ubicación existente en vez de crear otra 'Principal'", async () => {
    const antes = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie);
    const cantidadUbicacionesAntes = antes.body.length;

    const respuesta = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    expect(respuesta.status).toBe(201);

    const despues = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioA.cookie);

    expect(despues.body.length).toBe(cantidadUbicacionesAntes);
  });

  test("usa la ubicación indicada explícitamente", async () => {
    const ubicacion = await crearUbicacionDePrueba(propietarioA.cookie, "Vidriera");

    const respuesta = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido({ ubicacionId: ubicacion.id }));

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.stock.ubicacionId).toBe(ubicacion.id);
  });

  test("rechaza una ubicación que no es de este comercio", async () => {
    const ubicacionDeB = await crearUbicacionDePrueba(propietarioB.cookie, "Depósito de B");

    const respuesta = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido({ ubicacionId: ubicacionDeB.id }));

    expect(respuesta.status).toBe(400);
  });

  test.each([
    ["nombre", { nombre: "" }],
    ["codigoBarras", { codigoBarras: "abc" }],
    ["categoria", { categoria: "" }],
    ["unidadMedida", { unidadMedida: "toneladas" }],
    ["umbralMinimo", { umbralMinimo: -1 }],
    ["umbralMinimo", { umbralMinimo: 1.5 }],
    ["umbralMinimo", { umbralMinimo: 3000000000 }],
    ["stockActual", { stockActual: -5 }],
    ["stockActual", { stockActual: 3000000000 }],
  ])("rechaza datos inválidos en %s", async (_campo, override) => {
    const respuesta = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido(override));

    expect(respuesta.status).toBe(400);
  });

  test("rechaza un código de barras repetido en el mismo comercio", async () => {
    const datos = productoValido();

    const primera = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(datos);
    expect(primera.status).toBe(201);

    const segunda = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido({ codigoBarras: datos.codigoBarras }));

    expect(segunda.status).toBe(409);
  });

  test("el mismo código de barras puede repetirse en comercios distintos", async () => {
    const datos = productoValido();

    const deA = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(datos);
    expect(deA.status).toBe(201);

    const deB = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioB.cookie)
      .send(productoValido({ codigoBarras: datos.codigoBarras }));
    expect(deB.status).toBe(201);
  });

  test("dos altas simultáneas con el mismo código de barras no rompen con 500", async () => {
    const datos = productoValido();

    const [una, otra] = await Promise.all([
      request(app).post("/api/productos").set("Cookie", propietarioA.cookie).send(datos),
      request(app).post("/api/productos").set("Cookie", propietarioA.cookie).send(datos),
    ]);

    const codigos = [una.status, otra.status].sort();
    expect(codigos).toEqual([201, 409]);
  });
});

describe("Listado y obtención", () => {
  test("obtener por un id que no existe, es de otro comercio, o no es UUID → 404", async () => {
    const deB = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioB.cookie)
      .send(productoValido());

    const ajeno = await request(app)
      .get(`/api/productos/${deB.body.id}`)
      .set("Cookie", propietarioA.cookie);
    expect(ajeno.status).toBe(404);

    const inexistente = await request(app)
      .get("/api/productos/123e4567-e89b-12d3-a456-426614174000")
      .set("Cookie", propietarioA.cookie);
    expect(inexistente.status).toBe(404);

    const formatoInvalido = await request(app)
      .get("/api/productos/no-es-un-uuid")
      .set("Cookie", propietarioA.cookie);
    expect(formatoInvalido.status).toBe(404);
  });

  test("obtiene el producto cuando corresponde al comercio", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const respuesta = await request(app)
      .get(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.id).toBe(creado.body.id);
  });

  test("lista solo los productos activos del comercio de la sesión", async () => {
    const respuesta = await request(app)
      .get("/api/productos")
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(Array.isArray(respuesta.body)).toBe(true);
    expect(respuesta.body.length).toBeGreaterThan(0);
  });
});

describe("Edición", () => {
  test("actualiza solo los campos enviados y no modifica el stock", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const editado = await request(app)
      .put(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ categoria: "Almacén" });

    expect(editado.status).toBe(200);
    expect(editado.body.categoria).toBe("Almacén");
    expect(editado.body.nombre).toBe(creado.body.nombre);
    expect(editado.body).not.toHaveProperty("stockActual");
    expect(editado.body).not.toHaveProperty("stock");
  });

  test("rechaza con 400 un PUT sin ningún campo para actualizar", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const editado = await request(app)
      .put(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({});

    expect(editado.status).toBe(400);
  });

  test("rechaza un umbralMinimo inválido en el patch", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const editado = await request(app)
      .put(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ umbralMinimo: -10 });

    expect(editado.status).toBe(400);
  });

  test("rechaza con 409 si el nuevo código de barras colisiona con otro producto del comercio", async () => {
    const uno = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());
    const otro = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const editado = await request(app)
      .put(`/api/productos/${otro.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ codigoBarras: uno.body.codigoBarras });

    expect(editado.status).toBe(409);
  });

  test("rechaza con 404 si el producto no existe o es de otro comercio", async () => {
    const deB = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioB.cookie)
      .send(productoValido());

    const respuesta = await request(app)
      .put(`/api/productos/${deB.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ nombre: "Robado" });

    expect(respuesta.status).toBe(404);
  });
});

describe("Eliminación", () => {
  test("elimina (soft delete) un producto y desaparece de listar/obtener", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const borrado = await request(app)
      .delete(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie);
    expect(borrado.status).toBe(204);

    const obtenido = await request(app)
      .get(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie);
    expect(obtenido.status).toBe(404);

    const listado = await request(app)
      .get("/api/productos")
      .set("Cookie", propietarioA.cookie);
    expect(listado.body.map((p) => p.id)).not.toContain(creado.body.id);
  });

  test("es idempotente: repetir el DELETE (o sobre un id inexistente) sigue devolviendo 204", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    await request(app)
      .delete(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie);

    const repetido = await request(app)
      .delete(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie);
    expect(repetido.status).toBe(204);

    const inexistente = await request(app)
      .delete("/api/productos/123e4567-e89b-12d3-a456-426614174000")
      .set("Cookie", propietarioA.cookie);
    expect(inexistente.status).toBe(204);

    const formatoInvalido = await request(app)
      .delete("/api/productos/no-es-un-uuid")
      .set("Cookie", propietarioA.cookie);
    expect(formatoInvalido.status).toBe(204);
  });

  test("el código de barras de un producto borrado queda libre para un alta nueva", async () => {
    const datos = productoValido();

    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(datos);
    expect(creado.status).toBe(201);

    await request(app)
      .delete(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie);

    const nuevo = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send({ ...datos, nombre: "Coca-Cola 500ml (reemplazo)" });

    expect(nuevo.status).toBe(201);
    expect(nuevo.body.codigoBarras).toBe(datos.codigoBarras);
  });

  test("un producto borrado no se puede seguir editando", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    await request(app)
      .delete(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie);

    const editado = await request(app)
      .put(`/api/productos/${creado.body.id}`)
      .set("Cookie", propietarioA.cookie)
      .send({ categoria: "No debería aplicar" });

    expect(editado.status).toBe(404);
  });
});

describe("Alta concurrente sin ubicaciones previas (condición de carrera)", () => {
  test("dos altas simultáneas para un comercio sin ubicaciones crean una sola 'Principal'", async () => {
    const propietarioC = await registrarComercio("carrera-ubicacion");

    const [una, otra] = await Promise.all([
      request(app)
        .post("/api/productos")
        .set("Cookie", propietarioC.cookie)
        .send(productoValido()),
      request(app)
        .post("/api/productos")
        .set("Cookie", propietarioC.cookie)
        .send(productoValido()),
    ]);

    expect(una.status).toBe(201);
    expect(otra.status).toBe(201);
    expect(una.body.stock.ubicacionId).toBe(otra.body.stock.ubicacionId);

    const ubicaciones = await request(app)
      .get("/api/ubicaciones")
      .set("Cookie", propietarioC.cookie);

    expect(ubicaciones.body.map((u) => u.nombre)).toEqual(["Principal"]);
  });
});

describe("Aislamiento entre comercios (multi-tenant)", () => {
  test("cada comercio ve solo sus propios productos", async () => {
    const datos = productoValido();
    await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioB.cookie)
      .send(datos);

    const deA = await request(app)
      .get("/api/productos")
      .set("Cookie", propietarioA.cookie);

    expect(deA.body.map((p) => p.codigoBarras)).not.toContain(datos.codigoBarras);
  });
});

describe("Restricciones por rol", () => {
  test("un empleado puede leer pero no crear, editar ni eliminar productos", async () => {
    const empleado = await registrarComercio("empleado");

    const [fila] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, empleado.email));

    await db.update(member).set({ role: "empleado" }).where(eq(member.userId, fila.id));

    const lectura = await request(app)
      .get("/api/productos")
      .set("Cookie", empleado.cookie);
    expect(lectura.status).toBe(200);

    const alta = await request(app)
      .post("/api/productos")
      .set("Cookie", empleado.cookie)
      .send(productoValido());
    expect(alta.status).toBe(403);

    const edicion = await request(app)
      .put("/api/productos/123e4567-e89b-12d3-a456-426614174000")
      .set("Cookie", empleado.cookie)
      .send({ nombre: "No debería poder" });
    expect(edicion.status).toBe(403);

    const baja = await request(app)
      .delete("/api/productos/123e4567-e89b-12d3-a456-426614174000")
      .set("Cookie", empleado.cookie);
    expect(baja.status).toBe(403);
  });
});

describe("Consulta previa de código de barras (enhancement opcional, ver plan §10)", () => {
  test("rechaza un formato de código inválido", async () => {
    const respuesta = await request(app)
      .get("/api/productos/codigo/abc")
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(400);
  });

  test("devuelve existe:true con el producto si el código ya está en el comercio", async () => {
    const creado = await request(app)
      .post("/api/productos")
      .set("Cookie", propietarioA.cookie)
      .send(productoValido());

    const respuesta = await request(app)
      .get(`/api/productos/codigo/${creado.body.codigoBarras}`)
      .set("Cookie", propietarioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.existe).toBe(true);
    expect(respuesta.body.producto.id).toBe(creado.body.id);
  });

  test("devuelve existe:false con una sugerencia (o null) si el código es nuevo, sin romper nunca", async () => {
    const respuesta = await request(app)
      .get(`/api/productos/codigo/${codigoBarras()}`)
      .set("Cookie", propietarioA.cookie);

    // No se mockea la red real acá: el resultado de Open Food Facts puede
    // variar (o no responder) sin que eso sea una falla del endpoint. Lo que
    // importa es que nunca rompe y siempre devuelve la forma esperada.
    expect(respuesta.status).toBe(200);
    expect(respuesta.body.existe).toBe(false);
    expect(respuesta.body).toHaveProperty("sugerencia");
  }, 10000);
});