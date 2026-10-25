import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import { comercio, member, organization, user } from "../src/db/schema.js";
import { proveedoresDeProductos } from "../src/services/productoProveedor.service.js";

/**
 * Test de integracion de HU-20 (asociacion de productos a proveedores).
 *
 * Corre contra la base real: lo que se prueba es la PK compuesta (duplicado),
 * que las dos puntas sean del mismo comercio y que las bajas logicas escondan
 * el vinculo. Que rol puede que cosa lo cubre tests/controlAcceso.test.js.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu20-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";
const ID_INEXISTENTE = "123e4567-e89b-12d3-a456-426614174000";

let contador = 0;
function unico(base) {
  contador += 1;
  return `${base} ${contador}`;
}

function codigoBarras() {
  contador += 1;
  return `77900${Date.now().toString().slice(-6)}${contador}`.slice(0, 13);
}

async function registrarComercio(etiqueta) {
  const respuesta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: `Comercio ${etiqueta}`, email: correo(etiqueta), password: PASSWORD });

  expect(respuesta.status).toBe(200);

  return (respuesta.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function crearProducto(cookie, nombre = unico("Producto")) {
  const respuesta = await request(app)
    .post("/api/productos")
    .set("Cookie", cookie)
    .send({
      nombre,
      codigoBarras: codigoBarras(),
      categoria: "Almacén",
      unidadMedida: "unidad",
      umbralMinimo: 5,
      stockActual: 0,
    });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

async function crearProveedor(cookie, nombre = unico("Proveedor")) {
  const respuesta = await request(app)
    .post("/api/proveedores")
    .set("Cookie", cookie)
    .send({ nombre });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

function asociar(cookie, productoId, proveedorId) {
  return request(app)
    .post(`/api/productos/${productoId}/proveedores`)
    .set("Cookie", cookie)
    .send({ proveedorId });
}

function desasociar(cookie, productoId, proveedorId) {
  return request(app)
    .delete(`/api/productos/${productoId}/proveedores/${proveedorId}`)
    .set("Cookie", cookie);
}

function proveedoresDe(cookie, productoId) {
  return request(app)
    .get(`/api/productos/${productoId}/proveedores`)
    .set("Cookie", cookie);
}

function productosDe(cookie, proveedorId) {
  return request(app)
    .get(`/api/proveedores/${proveedorId}/productos`)
    .set("Cookie", cookie);
}

let cookieA;
let cookieB;
let comercioIdA;

beforeAll(async () => {
  cookieA = await registrarComercio("a");
  cookieB = await registrarComercio("b");

  const [fila] = await db
    .select({ id: comercio.id })
    .from(comercio)
    .innerJoin(member, eq(member.organizationId, comercio.organizationId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(user.email, correo("a")));
  comercioIdA = fila.id;
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = creadas.map((fila) => fila.organizationId);

  // El comercio primero: se lleva por cascada productos, proveedores y sus
  // vinculos (mismo orden que tests/productos.test.js).
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
  test("no se puede consultar ni modificar ningún vínculo", async () => {
    const base = `/api/productos/${ID_INEXISTENTE}/proveedores`;

    expect((await request(app).get(base)).status).toBe(401);
    expect((await request(app).post(base).send({ proveedorId: ID_INEXISTENTE })).status).toBe(401);
    expect((await request(app).delete(`${base}/${ID_INEXISTENTE}`)).status).toBe(401);
    expect((await request(app).get(`/api/proveedores/${ID_INEXISTENTE}/productos`)).status).toBe(401);
  });
});

describe("Asociar", () => {
  test("un producto puede tener varios proveedores, y se ve desde los dos lados", async () => {
    const yerba = await crearProducto(cookieA, unico("Yerba"));
    const zeta = await crearProveedor(cookieA, unico("Zeta"));
    const alfa = await crearProveedor(cookieA, unico("Alfa"));

    expect((await asociar(cookieA, yerba.id, zeta.id)).status).toBe(201);
    expect((await asociar(cookieA, yerba.id, alfa.id)).status).toBe(201);

    const proveedores = await proveedoresDe(cookieA, yerba.id);
    expect(proveedores.status).toBe(200);
    // Ordenados por nombre, con los datos para contactarlos.
    expect(proveedores.body.map((p) => p.id)).toEqual([alfa.id, zeta.id]);
    expect(proveedores.body[0]).toMatchObject({ nombre: alfa.nombre, telefono: null });

    const productos = await productosDe(cookieA, zeta.id);
    expect(productos.status).toBe(200);
    expect(productos.body).toEqual([
      expect.objectContaining({ id: yerba.id, nombre: yerba.nombre }),
    ]);
  });

  test("un proveedor puede tener varios productos", async () => {
    const proveedor = await crearProveedor(cookieA);
    const uno = await crearProducto(cookieA);
    const otro = await crearProducto(cookieA);

    await asociar(cookieA, uno.id, proveedor.id);
    await asociar(cookieA, otro.id, proveedor.id);

    const productos = await productosDe(cookieA, proveedor.id);
    expect(productos.body.map((p) => p.id).sort()).toEqual([uno.id, otro.id].sort());
  });

  test("asociar dos veces lo mismo responde 409", async () => {
    const producto = await crearProducto(cookieA);
    const proveedor = await crearProveedor(cookieA);
    await asociar(cookieA, producto.id, proveedor.id);

    const repetido = await asociar(cookieA, producto.id, proveedor.id);

    expect(repetido.status).toBe(409);
    expect(repetido.body.error).toMatch(/ya está asociado/i);
    expect((await proveedoresDe(cookieA, producto.id)).body).toHaveLength(1);
  });

  test("sin proveedor responde 400", async () => {
    const producto = await crearProducto(cookieA);

    const respuesta = await request(app)
      .post(`/api/productos/${producto.id}/proveedores`)
      .set("Cookie", cookieA)
      .send({});

    expect(respuesta.status).toBe(400);
  });

  test.each([
    ["el producto es de otro comercio", "producto"],
    ["el proveedor es de otro comercio", "proveedor"],
  ])("si %s responde 404 y no asocia nada", async (_caso, ajeno) => {
    const productoA = await crearProducto(cookieA);
    const proveedorA = await crearProveedor(cookieA);
    const productoB = await crearProducto(cookieB);
    const proveedorB = await crearProveedor(cookieB);

    const [productoId, proveedorId] =
      ajeno === "producto" ? [productoB.id, proveedorA.id] : [productoA.id, proveedorB.id];

    const respuesta = await asociar(cookieA, productoId, proveedorId);

    expect(respuesta.status).toBe(404);
    expect(respuesta.body.error).toBe(
      ajeno === "producto" ? "El producto no existe" : "El proveedor no existe",
    );
    expect((await proveedoresDe(cookieB, productoB.id)).body).toEqual([]);
    expect((await productosDe(cookieB, proveedorB.id)).body).toEqual([]);
  });

  test("con ids inexistentes o que no son UUID responde 404 y no 500", async () => {
    const producto = await crearProducto(cookieA);
    const proveedor = await crearProveedor(cookieA);

    expect((await asociar(cookieA, ID_INEXISTENTE, proveedor.id)).status).toBe(404);
    expect((await asociar(cookieA, producto.id, ID_INEXISTENTE)).status).toBe(404);
    expect((await asociar(cookieA, "no-es-uuid", proveedor.id)).status).toBe(404);
    expect((await asociar(cookieA, producto.id, "no-es-uuid")).status).toBe(404);
  });

  test("no se puede asociar un proveedor dado de baja", async () => {
    const producto = await crearProducto(cookieA);
    const proveedor = await crearProveedor(cookieA);
    await request(app).delete(`/api/proveedores/${proveedor.id}`).set("Cookie", cookieA);

    expect((await asociar(cookieA, producto.id, proveedor.id)).status).toBe(404);
  });
});

describe("Consultar", () => {
  test("los vínculos de otro comercio no se ven: 404, igual que inexistente", async () => {
    const productoB = await crearProducto(cookieB);
    const proveedorB = await crearProveedor(cookieB);
    await asociar(cookieB, productoB.id, proveedorB.id);

    expect((await proveedoresDe(cookieA, productoB.id)).status).toBe(404);
    expect((await productosDe(cookieA, proveedorB.id)).status).toBe(404);
  });

  test("un producto sin proveedores devuelve la lista vacía", async () => {
    const producto = await crearProducto(cookieA);

    const respuesta = await proveedoresDe(cookieA, producto.id);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual([]);
  });

  test("dar de baja un proveedor lo saca de los proveedores del producto", async () => {
    const producto = await crearProducto(cookieA);
    const queda = await crearProveedor(cookieA);
    const seVa = await crearProveedor(cookieA);
    await asociar(cookieA, producto.id, queda.id);
    await asociar(cookieA, producto.id, seVa.id);

    await request(app).delete(`/api/proveedores/${seVa.id}`).set("Cookie", cookieA);

    expect((await proveedoresDe(cookieA, producto.id)).body.map((p) => p.id)).toEqual([
      queda.id,
    ]);
  });

  test("dar de baja un producto lo saca de los productos del proveedor", async () => {
    const proveedor = await crearProveedor(cookieA);
    const producto = await crearProducto(cookieA);
    await asociar(cookieA, producto.id, proveedor.id);

    await request(app).delete(`/api/productos/${producto.id}`).set("Cookie", cookieA);

    expect((await productosDe(cookieA, proveedor.id)).body).toEqual([]);
  });
});

describe("Desasociar", () => {
  test("quita el vínculo y deja los demás", async () => {
    const producto = await crearProducto(cookieA);
    const queda = await crearProveedor(cookieA);
    const seVa = await crearProveedor(cookieA);
    await asociar(cookieA, producto.id, queda.id);
    await asociar(cookieA, producto.id, seVa.id);

    const respuesta = await desasociar(cookieA, producto.id, seVa.id);

    expect(respuesta.status).toBe(204);
    expect((await proveedoresDe(cookieA, producto.id)).body.map((p) => p.id)).toEqual([
      queda.id,
    ]);
    // El proveedor sigue existiendo: lo que se borró es el vínculo.
    expect(
      (await request(app).get(`/api/proveedores/${seVa.id}`).set("Cookie", cookieA)).status,
    ).toBe(200);
  });

  test("es idempotente, y después se puede volver a asociar", async () => {
    const producto = await crearProducto(cookieA);
    const proveedor = await crearProveedor(cookieA);
    await asociar(cookieA, producto.id, proveedor.id);

    expect((await desasociar(cookieA, producto.id, proveedor.id)).status).toBe(204);
    expect((await desasociar(cookieA, producto.id, proveedor.id)).status).toBe(204);
    expect((await desasociar(cookieA, "no-es-uuid", proveedor.id)).status).toBe(204);
    expect((await asociar(cookieA, producto.id, proveedor.id)).status).toBe(201);
  });

  test("no quita un vínculo de otro comercio", async () => {
    const productoB = await crearProducto(cookieB);
    const proveedorB = await crearProveedor(cookieB);
    await asociar(cookieB, productoB.id, proveedorB.id);

    expect((await desasociar(cookieA, productoB.id, proveedorB.id)).status).toBe(204);
    expect((await proveedoresDe(cookieB, productoB.id)).body).toHaveLength(1);
  });
});

describe("proveedoresDeProductos (para la reposición)", () => {
  test("agrupa por producto, solo activos y solo del comercio", async () => {
    const harina = await crearProducto(cookieA);
    const yerba = await crearProducto(cookieA);
    const sinNada = await crearProducto(cookieA);
    const activo = await crearProveedor(cookieA, unico("Activo"));
    const deBaja = await crearProveedor(cookieA, unico("DeBaja"));
    await asociar(cookieA, harina.id, activo.id);
    await asociar(cookieA, harina.id, deBaja.id);
    await asociar(cookieA, yerba.id, activo.id);
    await request(app).delete(`/api/proveedores/${deBaja.id}`).set("Cookie", cookieA);

    const porProducto = await proveedoresDeProductos(comercioIdA, [
      harina.id,
      yerba.id,
      sinNada.id,
    ]);

    expect(porProducto.get(harina.id).map((p) => p.id)).toEqual([activo.id]);
    expect(porProducto.get(yerba.id)).toEqual([
      { id: activo.id, nombre: activo.nombre, telefono: null, correo: null },
    ]);
    expect(porProducto.has(sinNada.id)).toBe(false);
  });

  test("con otro comercio no devuelve nada aunque los ids existan", async () => {
    const producto = await crearProducto(cookieA);
    const proveedor = await crearProveedor(cookieA);
    await asociar(cookieA, producto.id, proveedor.id);

    const porProducto = await proveedoresDeProductos(ID_INEXISTENTE, [producto.id]);

    expect(porProducto.size).toBe(0);
  });

  test("sin productos no consulta y devuelve un Map vacío", async () => {
    expect((await proveedoresDeProductos(comercioIdA, [])).size).toBe(0);
  });
});
