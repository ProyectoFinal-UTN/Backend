import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
import { randomUUID } from "node:crypto";

/**
 * Test de integracion de HU-18 (notificaciones push de reposicion, SCRUM-127).
 *
 * Corre contra la base real, como tests/umbrales.test.js: el disparo depende
 * del stock que deja el movimiento confirmado, de las suscripciones guardadas y
 * de quien es miembro de cada comercio, y eso solo se prueba con filas de
 * verdad.
 *
 * Lo unico mockeado es `src/lib/push.js`, el archivo que habla con el servicio
 * de push: ningun test manda una notificacion real, y asi se puede simular un
 * 410 o una caida del servicio.
 */

const enviarPush = jest.fn(async () => {});
const pushHabilitado = jest.fn(() => true);
const clavePublica = jest.fn(() => "BClavePublicaDePrueba");

jest.unstable_mockModule("../src/lib/push.js", () => ({
  enviarPush,
  pushHabilitado,
  clavePublica,
}));

const { default: request } = await import("supertest");
const { and, eq, inArray, like } = await import("drizzle-orm");
const { app } = await import("../src/app.js");
const { cerrarConexion, db } = await import("../src/db/client.js");
const { comercio, member, organization, suscripcionPush, user } = await import(
  "../src/db/schema.js"
);
const { esperarAvisosPendientes } = await import(
  "../src/services/push.service.js"
);

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu18-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";
const P256DH =
  "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
const AUTH = "tBHItJI5svbpez7KI4CCXg";

let contadorEndpoint = 0;
/** Endpoint unico por llamada, para no chocar entre tests ni entre corridas. */
function endpointNuevo() {
  contadorEndpoint += 1;
  return `https://push.example.test/${SUFIJO}/${contadorEndpoint}`;
}

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `77918${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
}

/** Registra un comercio nuevo y devuelve su cookie de sesion y su usuario. */
async function registrarComercio(etiqueta) {
  const email = correo(etiqueta);

  const respuesta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({ name: `Comercio ${etiqueta}`, email, password: PASSWORD });

  expect(respuesta.status).toBe(200);

  const cookie = (respuesta.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");

  const [fila] = await db
    .select({
      usuarioId: user.id,
      organizationId: member.organizationId,
      comercioId: comercio.id,
    })
    .from(user)
    .innerJoin(member, eq(member.userId, user.id))
    .innerJoin(comercio, eq(comercio.organizationId, member.organizationId))
    .where(eq(user.email, email));

  return { email, cookie, ...fila };
}

async function crearProducto(cookie, { umbralMinimo, stockActual, nombre = "Yerba 1 kg" }) {
  const respuesta = await request(app)
    .post("/api/productos")
    .set("Cookie", cookie)
    .send({
      nombre,
      codigoBarras: codigoBarras(),
      categoria: "Almacén",
      unidadMedida: "unidad",
      umbralMinimo,
      stockActual,
    });

  expect(respuesta.status).toBe(201);
  return respuesta.body;
}

const suscribir = (cookie, body) =>
  request(app).post("/api/push/suscripciones").set("Cookie", cookie).send(body);

const desuscribir = (cookie, body) =>
  request(app).delete("/api/push/suscripciones").set("Cookie", cookie).send(body);

function suscripcion(endpoint) {
  return { endpoint, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } };
}

/** Suscribe un dispositivo nuevo y devuelve su endpoint. */
async function suscribirDispositivo(cookie) {
  const endpoint = endpointNuevo();
  const respuesta = await suscribir(cookie, suscripcion(endpoint));
  expect(respuesta.status).toBe(201);
  return endpoint;
}

/** Registra un movimiento y espera a que termine el aviso en segundo plano. */
async function registrarMovimiento(cookie, body) {
  const respuesta = await request(app)
    .post("/api/movimientos")
    .set("Cookie", cookie)
    .send(body);
  await esperarAvisosPendientes();
  return respuesta;
}

const vender = (cookie, productoId, cantidad) =>
  registrarMovimiento(cookie, { productoId, tipo: "venta", cantidad });

const filasDe = (endpoint) =>
  db.select().from(suscripcionPush).where(eq(suscripcionPush.endpoint, endpoint));

const endpointsNotificados = () =>
  enviarPush.mock.calls.map(([destino]) => destino.endpoint).sort();

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

  // El comercio va antes que el usuario, como en tests/umbrales.test.js: se
  // lleva por cascada productos, stock y suscripciones.
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
  test("los tres endpoints responden 401", async () => {
    const clave = await request(app).get("/api/push/clave-publica");
    const alta = await request(app)
      .post("/api/push/suscripciones")
      .send(suscripcion(endpointNuevo()));
    const baja = await request(app)
      .delete("/api/push/suscripciones")
      .send({ endpoint: endpointNuevo() });

    expect(clave.status).toBe(401);
    expect(alta.status).toBe(401);
    expect(baja.status).toBe(401);
  });
});

describe("GET /api/push/clave-publica", () => {
  test("devuelve la clave pública VAPID", async () => {
    const respuesta = await request(app)
      .get("/api/push/clave-publica")
      .set("Cookie", comercioA.cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body).toEqual({ clavePublica: "BClavePublicaDePrueba" });
  });

  test("sin claves VAPID configuradas responde 503", async () => {
    clavePublica.mockReturnValueOnce(null);

    const respuesta = await request(app)
      .get("/api/push/clave-publica")
      .set("Cookie", comercioA.cookie);

    expect(respuesta.status).toBe(503);
  });
});

describe("POST /api/push/suscripciones", () => {
  test("guarda la suscripción a nombre del usuario y comercio de la sesión, no del body", async () => {
    const endpoint = endpointNuevo();

    const respuesta = await suscribir(comercioA.cookie, {
      ...suscripcion(endpoint),
      comercioId: comercioB.comercioId,
      usuarioId: comercioB.usuarioId,
    });

    expect(respuesta.status).toBe(201);
    expect(respuesta.body).toEqual({ endpoint, expiraEn: null });

    const [fila] = await filasDe(endpoint);
    expect(fila.comercioId).toBe(comercioA.comercioId);
    expect(fila.usuarioId).toBe(comercioA.usuarioId);
    expect(fila.p256dh).toBe(P256DH);
    expect(fila.auth).toBe(AUTH);
  });

  test("el upsert no duplica: suscribir dos veces el mismo endpoint deja una fila", async () => {
    const endpoint = endpointNuevo();

    expect((await suscribir(comercioA.cookie, suscripcion(endpoint))).status).toBe(201);
    expect((await suscribir(comercioA.cookie, suscripcion(endpoint))).status).toBe(201);

    expect(await filasDe(endpoint)).toHaveLength(1);
  });

  test("si otro usuario se suscribe desde el mismo dispositivo, la fila se reasigna", async () => {
    const endpoint = endpointNuevo();

    await suscribir(comercioA.cookie, suscripcion(endpoint));
    await suscribir(comercioB.cookie, suscripcion(endpoint));

    const filas = await filasDe(endpoint);
    expect(filas).toHaveLength(1);
    expect(filas[0].comercioId).toBe(comercioB.comercioId);
    expect(filas[0].usuarioId).toBe(comercioB.usuarioId);
  });

  test.each([
    ["sin endpoint", { keys: { p256dh: P256DH, auth: AUTH } }],
    ["endpoint http", suscripcion("http://push.example.test/x")],
    ["sin keys", { endpoint: "https://push.example.test/sin-keys" }],
    ["sin auth", { endpoint: "https://push.example.test/sin-auth", keys: { p256dh: P256DH } }],
    ["body vacío", {}],
  ])("%s → 400 y no guarda nada", async (_caso, body) => {
    const respuesta = await suscribir(comercioA.cookie, body);

    expect(respuesta.status).toBe(400);
    expect(respuesta.body.error).toMatch(/suscripción/i);
  });
});

describe("DELETE /api/push/suscripciones", () => {
  test("borra la suscripción del usuario (silenciar)", async () => {
    const endpoint = await suscribirDispositivo(comercioA.cookie);

    const respuesta = await desuscribir(comercioA.cookie, { endpoint });

    expect(respuesta.status).toBe(204);
    expect(await filasDe(endpoint)).toHaveLength(0);
  });

  test("un endpoint que no existe responde 204 igual", async () => {
    const respuesta = await desuscribir(comercioA.cookie, { endpoint: endpointNuevo() });
    expect(respuesta.status).toBe(204);
  });

  test("no borra la suscripción de otro usuario", async () => {
    const endpoint = await suscribirDispositivo(comercioB.cookie);

    const respuesta = await desuscribir(comercioA.cookie, { endpoint });

    expect(respuesta.status).toBe(204);
    expect(await filasDe(endpoint)).toHaveLength(1);
  });

  test("sin endpoint → 400", async () => {
    const respuesta = await desuscribir(comercioA.cookie, {});
    expect(respuesta.status).toBe(400);
  });
});

describe("Disparo del aviso al registrar un movimiento", () => {
  // Comercios propios para este bloque: las suscripciones de los tests de
  // arriba no tienen que contar como destinatarios aca.
  let tienda;
  let otraTienda;
  let dispositivo1;
  let dispositivo2;
  let dispositivoDeOtraTienda;

  beforeAll(async () => {
    tienda = await registrarComercio("tienda");
    otraTienda = await registrarComercio("otra-tienda");
    dispositivo1 = await suscribirDispositivo(tienda.cookie);
    dispositivo2 = await suscribirDispositivo(tienda.cookie);
    dispositivoDeOtraTienda = await suscribirDispositivo(otraTienda.cookie);
  });

  test("al alcanzar el umbral se manda a cada suscripción del comercio, con el payload del contrato", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 14 });

    const respuesta = await vender(tienda.cookie, producto.id, 11);

    expect(respuesta.status).toBe(201);
    expect(endpointsNotificados()).toEqual([dispositivo1, dispositivo2].sort());
    expect(endpointsNotificados()).not.toContain(dispositivoDeOtraTienda);

    for (const [, contenido] of enviarPush.mock.calls) {
      expect(contenido).toEqual({
        tipo: "alerta_reposicion",
        titulo: "Reponer: Yerba 1 kg",
        cuerpo: "Stock actual: 3 (mínimo 10)",
        productoId: producto.id,
        stockActual: 3,
        umbralMinimo: 10,
      });
    }
  });

  test("quedar justo en el umbral también avisa", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 12 });

    await vender(tienda.cookie, producto.id, 2);

    expect(enviarPush).toHaveBeenCalledTimes(2);
  });

  test("si el stock queda por encima del umbral no se manda", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 20 });

    expect((await vender(tienda.cookie, producto.id, 5)).status).toBe(201);
    expect(enviarPush).not.toHaveBeenCalled();
  });

  test("si ya estaba por debajo del umbral no se repite", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 8 });

    expect((await vender(tienda.cookie, producto.id, 1)).status).toBe(201);
    expect(enviarPush).not.toHaveBeenCalled();
  });

  test("un producto sin umbral configurado no avisa aunque se quede sin stock", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 0, stockActual: 5 });

    expect((await vender(tienda.cookie, producto.id, 5)).status).toBe(201);
    expect(enviarPush).not.toHaveBeenCalled();
  });

  // `stockActual: 0` y no 2: con stock inicial el alta ya deja la alerta
  // creada (HU-17), y entonces la compra no avisaria por estar repitiendo una
  // alerta vieja, no por ser una entrada — el test pasaria sin probar nada.
  // Arrancando en 0 no hay alerta previa (`crearProducto` no registra
  // movimiento si no hay stock), asi que esta compra es la que la abre, y lo
  // unico que frena el push es que sea una entrada.
  test("una compra no avisa, ni siquiera cuando es la que abre la alerta", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 0 });

    const respuesta = await registrarMovimiento(tienda.cookie, {
      productoId: producto.id,
      tipo: "compra",
      cantidad: 1,
    });

    expect(respuesta.status).toBe(201);
    expect(enviarPush).not.toHaveBeenCalled();
  });

  test("un movimiento rechazado no avisa", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 14 });

    // Stock insuficiente: el movimiento no se registra, asi que no hubo cruce.
    expect((await vender(tienda.cookie, producto.id, 99)).status).toBe(409);
    expect(enviarPush).not.toHaveBeenCalled();
  });
});

describe("Fallas de envío", () => {
  let tienda;
  let dispositivo;

  beforeAll(async () => {
    tienda = await registrarComercio("fallas");
  });

  test("una suscripción vencida (410) se borra y el movimiento se registra igual", async () => {
    dispositivo = await suscribirDispositivo(tienda.cookie);
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 14 });
    enviarPush.mockRejectedValueOnce(
      Object.assign(new Error("Gone"), { statusCode: 410 }),
    );

    const respuesta = await vender(tienda.cookie, producto.id, 11);

    expect(respuesta.status).toBe(201);
    expect(respuesta.body.stock.cantidad).toBe(3);
    expect(enviarPush).toHaveBeenCalledTimes(1);
    expect(await filasDe(dispositivo)).toHaveLength(0);
  });

  test("una suscripción que ya no existe (404) también se borra", async () => {
    dispositivo = await suscribirDispositivo(tienda.cookie);
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 14 });
    enviarPush.mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { statusCode: 404 }),
    );

    expect((await vender(tienda.cookie, producto.id, 11)).status).toBe(201);
    expect(await filasDe(dispositivo)).toHaveLength(0);
  });

  test("otro error se loguea, no borra la suscripción y el movimiento se registra igual", async () => {
    dispositivo = await suscribirDispositivo(tienda.cookie);
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 14 });
    const consola = jest.spyOn(console, "error").mockImplementation(() => {});
    enviarPush.mockRejectedValueOnce(
      Object.assign(new Error("Service Unavailable"), { statusCode: 503 }),
    );

    try {
      const respuesta = await vender(tienda.cookie, producto.id, 11);

      expect(respuesta.status).toBe(201);
      expect(respuesta.body.stock.cantidad).toBe(3);
      expect(consola).toHaveBeenCalledWith(
        expect.stringContaining("[push]"),
        503,
        "Service Unavailable",
      );
      expect(await filasDe(dispositivo)).toHaveLength(1);
    } finally {
      consola.mockRestore();
    }
  });

  test("con el push desactivado no se intenta mandar nada", async () => {
    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 14 });
    pushHabilitado.mockReturnValueOnce(false);

    expect((await vender(tienda.cookie, producto.id, 11)).status).toBe(201);
    expect(enviarPush).not.toHaveBeenCalled();
  });
});

describe("Usuarios sin permiso", () => {
  test("no reciben quien ya no es miembro del comercio ni un rol sin permiso sobre alertas", async () => {
    const tienda = await registrarComercio("permisos");
    const exEmpleado = await registrarComercio("ex-empleado");
    const sinPermiso = await registrarComercio("sin-permiso");
    const propio = await suscribirDispositivo(tienda.cookie);

    // Un celular que quedo suscripto a la tienda, de alguien que ya no es parte
    // del equipo: su usuario no tiene fila en MEMBER para esta organizacion.
    const delExEmpleado = endpointNuevo();
    await db.insert(suscripcionPush).values({
      comercioId: tienda.comercioId,
      usuarioId: exEmpleado.usuarioId,
      endpoint: delExEmpleado,
      p256dh: P256DH,
      auth: AUTH,
    });

    // Un miembro de la tienda con un rol que no tiene `alerta: read`.
    await db.insert(member).values({
      id: randomUUID(),
      organizationId: tienda.organizationId,
      userId: sinPermiso.usuarioId,
      role: "rol-sin-alertas",
      createdAt: new Date(),
    });
    const delSinPermiso = endpointNuevo();
    await db.insert(suscripcionPush).values({
      comercioId: tienda.comercioId,
      usuarioId: sinPermiso.usuarioId,
      endpoint: delSinPermiso,
      p256dh: P256DH,
      auth: AUTH,
    });

    const producto = await crearProducto(tienda.cookie, { umbralMinimo: 10, stockActual: 14 });
    await vender(tienda.cookie, producto.id, 11);

    expect(endpointsNotificados()).toEqual([propio]);

    // Las suscripciones no se borran: no estan vencidas, solo no les toca.
    expect(await filasDe(delExEmpleado)).toHaveLength(1);
    expect(await filasDe(delSinPermiso)).toHaveLength(1);

    await db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, tienda.organizationId),
          eq(member.userId, sinPermiso.usuarioId),
        ),
      );
  });
});
