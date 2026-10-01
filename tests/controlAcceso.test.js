import http from "node:http";
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
import { permisosDe } from "../src/lib/permissions.js";
import { SIN_PERMISO } from "../src/middlewares/auth.middleware.js";
import auditoriaRoutes from "../src/routes/auditoria.routes.js";
import comerciosRoutes from "../src/routes/comercios.routes.js";
import configuracionRoutes from "../src/routes/configuracion.routes.js";
import datosPersonalesRoutes from "../src/routes/datosPersonales.routes.js";
import invitacionesRoutes from "../src/routes/invitaciones.routes.js";
import miembrosRoutes from "../src/routes/miembros.routes.js";
import movimientosRoutes from "../src/routes/movimientos.routes.js";
import productosRoutes from "../src/routes/productos.routes.js";
import transferenciasRoutes from "../src/routes/transferencias.routes.js";
import ubicacionesRoutes from "../src/routes/ubicaciones.routes.js";

/**
 * Control de acceso por rol (HU-32).
 *
 * Tres partes:
 *
 * 1. Guardia estructural: recorre todas las rutas montadas en la app y exige
 *    que cada una valide el permiso, salvo las excepciones listadas a mano. Es
 *    el criterio "cada endpoint valida el rol" convertido en algo que se rompe
 *    solo el dia que alguien agrega una ruta sin guarda.
 * 2. Matriz endpoint x rol contra la base real: sin sesion 401, rol no
 *    autorizado 403 con el mensaje unico, rol autorizado pasa la puerta. Se
 *    prueba la puerta, no la logica: el rol autorizado puede terminar en 400 o
 *    404 por mandar datos vacios o ids que no existen, y eso esta bien. La
 *    logica de cada endpoint la cubre la spec de su HU.
 * 3. Los endpoints del plugin de organizacion de Better Auth, que salteaban la
 *    matriz y quedan cerrados.
 */

const P = "propietario";
const G = "gerente";
const E = "empleado";

const ID_FALSO = "123e4567-e89b-12d3-a456-426614174000";
const CODIGO = "7790000000000";

/**
 * [metodo, ruta, roles que pasan la puerta]. Es el inventario de HU-32: si se
 * cambia quien puede hacer algo en src/lib/permissions.js, esta tabla tiene
 * que cambiar a la par, y el diff del PR lo deja a la vista.
 */
const MATRIZ = [
  ["GET", "/api/comercio", [P, G, E]],
  ["PUT", "/api/comercio", [P]],
  ["GET", "/api/configuracion", [P, G, E]],
  ["PUT", "/api/configuracion/moneda", [P]],
  ["GET", "/api/miembros", [P, G]],
  ["POST", "/api/miembros/invitaciones", [P]],
  ["DELETE", `/api/miembros/invitaciones/${ID_FALSO}`, [P]],
  ["PUT", `/api/miembros/${ID_FALSO}/rol`, [P]],
  ["DELETE", `/api/miembros/${ID_FALSO}`, [P]],
  ["GET", "/api/auditoria", [P]],
  ["GET", "/api/ubicaciones", [P, G, E]],
  ["POST", "/api/ubicaciones", [P, G]],
  ["PUT", `/api/ubicaciones/${ID_FALSO}`, [P, G]],
  ["DELETE", `/api/ubicaciones/${ID_FALSO}`, [P, G]],
  ["GET", "/api/productos", [P, G, E]],
  ["GET", `/api/productos/codigo/${CODIGO}`, [P, G]],
  ["GET", `/api/productos/${ID_FALSO}`, [P, G, E]],
  ["POST", "/api/productos", [P, G]],
  ["POST", "/api/productos/importar", [P, G]],
  ["PUT", `/api/productos/${ID_FALSO}`, [P, G]],
  ["DELETE", `/api/productos/${ID_FALSO}`, [P, G]],
  ["GET", "/api/movimientos", [P, G, E]],
  ["POST", "/api/movimientos", [P, G, E]],
  ["POST", "/api/transferencias", [P, G, E]],
  ["GET", "/api/mis-datos", [P, G, E]],
];

/**
 * Rutas con permiso que no entran en la matriz porque el caso autorizado es
 * destructivo: probarlo borraria la cuenta del escenario. Su 401 se prueba
 * aca; su camino feliz, en la spec de su HU.
 */
const CON_PERMISO_FUERA_DE_LA_MATRIZ = {
  "DELETE /api/mi-cuenta": "da de baja la cuenta (datosPersonales.test.js)",
};

// --- 1. Guardia estructural -------------------------------------------------

/**
 * Donde se monta cada router en `app.js`. Express 5 no guarda el path de
 * montaje en la capa, asi que los routers se reconocen por identidad: si se
 * monta uno que no esta aca, la guardia falla y obliga a sumarlo.
 */
const MONTAJES = new Map([
  [datosPersonalesRoutes, "/api"],
  [miembrosRoutes, "/api/miembros"],
  [invitacionesRoutes, "/api/invitaciones"],
  [comerciosRoutes, "/api/comercio"],
  [auditoriaRoutes, "/api/auditoria"],
  [ubicacionesRoutes, "/api/ubicaciones"],
  [configuracionRoutes, "/api/configuracion"],
  [productosRoutes, "/api/productos"],
  [movimientosRoutes, "/api/movimientos"],
  [transferenciasRoutes, "/api/transferencias"],
]);

/**
 * Las unicas rutas que no validan permiso, cada una con su motivo. Sumar una
 * aca es una decision de seguridad y tiene que pasar por review.
 */
const SIN_CONTROL_DE_ROL = {
  // HU-4: quien recibe el link todavia no tiene cuenta.
  "GET /api/invitaciones/:id": "publica",
  // HU-4: quien acepta todavia no tiene rol en ese comercio.
  "POST /api/invitaciones/:id/aceptar": "sin rol todavia",
};

/** Rutas declaradas directo en la app, fuera de los routers. */
const RUTAS_DE_APP = ["ALL /api/auth/{*any}", "GET /health"];

/** Nombres con que aparecen los middlewares en la pila de Express. */
const VALIDA_PERMISO = "verificarPermiso";
const VALIDA_SESION = "requireAuth";

function metodosDe(ruta) {
  const metodos = Object.keys(ruta.methods).filter((m) => ruta.methods[m]);
  // `app.all` marca todos los verbos.
  return metodos.length > 10 ? ["ALL"] : metodos.map((m) => m.toUpperCase());
}

/** Todas las rutas de la app, con los middlewares que las protegen. */
function inventariarRutas() {
  const rutas = [];
  const routersDesconocidos = [];

  for (const capa of app.router.stack) {
    if (capa.route) {
      for (const metodo of metodosDe(capa.route)) {
        rutas.push({ clave: `${metodo} ${capa.route.path}`, deApp: true });
      }
      continue;
    }

    const subrutas = capa.handle?.stack;

    if (!subrutas) {
      continue;
    }

    const montaje = MONTAJES.get(capa.handle);

    if (!montaje) {
      routersDesconocidos.push(capa.handle);
      continue;
    }

    let sesionEnElRouter = false;

    for (const sub of subrutas) {
      if (!sub.route) {
        // `router.use(requireAuth)` protege lo que viene despues.
        if (sub.name === VALIDA_SESION) {
          sesionEnElRouter = true;
        }
        continue;
      }

      const nombres = sub.route.stack.map((paso) => paso.name);
      const camino = `${montaje}${sub.route.path === "/" ? "" : sub.route.path}`;

      for (const metodo of metodosDe(sub.route)) {
        rutas.push({
          clave: `${metodo} ${camino}`,
          deApp: false,
          validaSesion: sesionEnElRouter || nombres.includes(VALIDA_SESION),
          validaPermiso: nombres.includes(VALIDA_PERMISO),
          // El permiso es lo primero de la ruta despues de la sesion: si
          // antes corriera, por ejemplo, la subida del CSV, un rol sin permiso
          // ya habria mandado el archivo entero antes de recibir el 403.
          permisoPrimero:
            nombres.filter((nombre) => nombre !== VALIDA_SESION)[0] ===
            VALIDA_PERMISO,
        });
      }
    }
  }

  return { rutas, routersDesconocidos };
}

describe("Guardia: cada endpoint valida el rol", () => {
  const { rutas, routersDesconocidos } = inventariarRutas();

  test("no hay routers montados que la guardia no conozca", () => {
    expect(routersDesconocidos).toHaveLength(0);
  });

  test("las unicas rutas sueltas en la app son las de Better Auth y /health", () => {
    const deApp = rutas.filter((r) => r.deApp).map((r) => r.clave);
    expect(deApp.sort()).toEqual([...RUTAS_DE_APP].sort());
  });

  test("toda ruta de negocio valida sesion y permiso, salvo las excepciones", () => {
    const sinGuarda = rutas
      .filter((r) => !r.deApp)
      .filter((r) => !(r.clave in SIN_CONTROL_DE_ROL))
      .filter((r) => !r.validaSesion || !r.validaPermiso)
      .map((r) => r.clave);

    expect(sinGuarda).toEqual([]);
  });

  test("el permiso se valida antes que cualquier otro paso de la ruta", () => {
    const tarde = rutas
      .filter((r) => r.validaPermiso && !r.permisoPrimero)
      .map((r) => r.clave);

    expect(tarde).toEqual([]);
  });

  test("las excepciones siguen existiendo (si se borra una ruta, se borra de la lista)", () => {
    const claves = new Set(rutas.map((r) => r.clave));

    for (const excepcion of Object.keys(SIN_CONTROL_DE_ROL)) {
      expect(claves).toContain(excepcion);
    }
  });

  test("la matriz cubre exactamente las rutas con permiso", () => {
    const conPermiso = rutas
      .filter((r) => r.validaPermiso)
      .map((r) => r.clave)
      .filter((clave) => !(clave in CON_PERMISO_FUERA_DE_LA_MATRIZ))
      .sort();

    const enLaMatriz = MATRIZ.map(([metodo, ruta]) =>
      `${metodo} ${ruta}`
        .replace(`/codigo/${CODIGO}`, "/codigo/:codigoBarras")
        .replace(ID_FALSO, ":id"),
    ).sort();

    expect(enLaMatriz).toEqual(conPermiso);
  });
});

// --- 2. Matriz endpoint x rol, contra la base real --------------------------

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PASSWORD = "unaClaveSegura123";

const correoDe = (etiqueta) => `test-hu32-${etiqueta}-${SUFIJO}@test.local`;

const sesiones = {};

function cookiesDe(respuesta) {
  return (respuesta.headers["set-cookie"] ?? [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

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

/** Suma a alguien al comercio del propietario, con el rol pedido (HU-4). */
async function sumarAlEquipo(etiqueta, rol) {
  const invitacion = await request(app)
    .post("/api/miembros/invitaciones")
    .set("Cookie", sesiones[P].cookie)
    .send({ correo: correoDe(etiqueta), rol });

  if (invitacion.status !== 201) {
    throw new Error(`No se pudo invitar a ${etiqueta}: ${invitacion.status}`);
  }

  return registrar(etiqueta, invitacion.body.id);
}

/**
 * GET por HTTP crudo, con el path tal cual (sin resolver `..` ni `%2e`), como
 * lo manda `curl --path-as-is`.
 */
function pedirCrudo(path, cookie) {
  return new Promise((resolver, rechazar) => {
    const servidor = app.listen(0, () => {
      const pedido = http.get(
        {
          port: servidor.address().port,
          path,
          headers: { Cookie: cookie },
        },
        (respuesta) => {
          let cuerpo = "";
          respuesta.on("data", (parte) => {
            cuerpo += parte;
          });
          respuesta.on("end", () => {
            servidor.close();
            resolver({ status: respuesta.statusCode, cuerpo });
          });
        },
      );

      pedido.on("error", (error) => {
        servidor.close();
        rechazar(error);
      });
    });
  });
}

function pedir(metodo, ruta, cookie) {
  const pedido = request(app)[metodo.toLowerCase()](ruta);

  if (cookie) {
    pedido.set("Cookie", cookie);
  }

  // Cuerpo vacio: alcanza para probar la puerta sin crear nada.
  return metodo === "GET" || metodo === "DELETE" ? pedido : pedido.send({});
}

beforeAll(async () => {
  sesiones[P] = await registrar("dueno");
  sesiones[G] = await sumarAlEquipo("encargado", G);
  sesiones[E] = await sumarAlEquipo("cajero", E);
});

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = [...new Set(creadas.map((fila) => fila.organizationId))];

  // El comercio primero: si un rol autorizado llegara a crear algo, las FK
  // `restrict` hacia `user` harian fallar el borrado del usuario.
  if (ids.length > 0) {
    await db.delete(invitation).where(inArray(invitation.organizationId, ids));
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
});

describe("El equipo del escenario tiene los roles que dice", () => {
  test.each([G, E])("%s pertenece al comercio del propietario", async (rol) => {
    const lista = await request(app)
      .get("/api/miembros")
      .set("Cookie", sesiones[P].cookie);

    const fila = lista.body.miembros.find(
      (m) => m.correo === sesiones[rol].email,
    );

    expect(fila?.rol).toBe(rol);
  });
});

describe.each(MATRIZ)("%s %s", (metodo, ruta, permitidos) => {
  test("sin sesion responde 401", async () => {
    const respuesta = await pedir(metodo, ruta);

    expect(respuesta.status).toBe(401);
  });

  test.each(permitidos)("%s pasa la puerta", async (rol) => {
    const respuesta = await pedir(metodo, ruta, sesiones[rol].cookie);

    expect(respuesta.status).not.toBe(401);
    expect(respuesta.status).not.toBe(403);
  });

  const denegados = [P, G, E].filter((rol) => !permitidos.includes(rol));

  // `test.each` no acepta una lista vacia: los endpoints abiertos a los tres
  // roles no tienen caso de 403.
  if (denegados.length > 0) {
    test.each(denegados)("%s recibe 403", async (rol) => {
      const respuesta = await pedir(metodo, ruta, sesiones[rol].cookie);

      expect(respuesta.status).toBe(403);
      expect(respuesta.body).toEqual({ error: SIN_PERMISO });
    });
  }
});

describe.each(Object.keys(CON_PERMISO_FUERA_DE_LA_MATRIZ))("%s", (clave) => {
  const [metodo, ruta] = clave.split(" ");

  test("valida el permiso", () => {
    const { rutas } = inventariarRutas();
    const fila = rutas.find((r) => r.clave === clave);

    expect(fila?.validaPermiso).toBe(true);
  });

  test("sin sesion responde 401", async () => {
    expect((await pedir(metodo, ruta)).status).toBe(401);
  });
});

// --- Datos recortados: se puede llamar, pero no todo sale -------------------

describe("Historial de movimientos: el correo de quien registro", () => {
  beforeAll(async () => {
    // Un movimiento registrado por el empleado y otro por el gerente, para que
    // el historial tenga correos ajenos que el empleado no deberia ver.
    const ubicacionId = (
      await request(app)
        .post("/api/ubicaciones")
        .set("Cookie", sesiones[P].cookie)
        .send({ nombre: "Depósito HU-32" })
    ).body.id;

    const producto = await request(app)
      .post("/api/productos")
      .set("Cookie", sesiones[P].cookie)
      .send({
        nombre: "Producto HU-32",
        codigoBarras: `32${Date.now()}`.slice(0, 13),
        categoria: "Bebidas",
        unidadMedida: "unidad",
        umbralMinimo: 1,
        stockActual: 10,
        ubicacionId,
      });

    for (const rol of [G, E]) {
      const movimiento = await request(app)
        .post("/api/movimientos")
        .set("Cookie", sesiones[rol].cookie)
        .send({
          productoId: producto.body.id,
          ubicacionId,
          tipo: "compra",
          cantidad: 1,
        });

      if (movimiento.status !== 201) {
        throw new Error(
          `No se pudo registrar el movimiento de ${rol}: ${movimiento.status} ${JSON.stringify(movimiento.body)}`,
        );
      }
    }
  });

  async function historialDe(rol) {
    const respuesta = await request(app)
      .get("/api/movimientos")
      .set("Cookie", sesiones[rol].cookie);

    expect(respuesta.status).toBe(200);
    return respuesta.body.movimientos;
  }

  test("el empleado ve quien registro cada movimiento, por nombre", async () => {
    const movimientos = await historialDe(E);

    expect(movimientos.length).toBeGreaterThanOrEqual(2);
    for (const movimiento of movimientos) {
      expect(movimiento.usuario.nombre).toBeTruthy();
      expect(movimiento.usuario).not.toHaveProperty("correo");
    }
  });

  test("ningun correo del equipo aparece en la respuesta del empleado", async () => {
    const respuesta = await request(app)
      .get("/api/movimientos")
      .set("Cookie", sesiones[E].cookie);

    const cuerpo = JSON.stringify(respuesta.body);

    for (const rol of [P, G, E]) {
      expect(cuerpo).not.toContain(sesiones[rol].email);
    }
  });

  test.each([P, G])("%s si ve los correos (puede ver el equipo)", async (rol) => {
    const movimientos = await historialDe(rol);
    const correos = movimientos.map((m) => m.usuario.correo);

    expect(correos).toContain(sesiones[G].email);
    expect(correos).toContain(sesiones[E].email);
  });
});

describe("GET /api/configuracion informa los permisos del rol", () => {
  async function configuracionDe(rol) {
    const respuesta = await request(app)
      .get("/api/configuracion")
      .set("Cookie", sesiones[rol].cookie);

    expect(respuesta.status).toBe(200);
    return respuesta.body;
  }

  test.each([P, G, E])("%s recibe los suyos y solo los suyos", async (rol) => {
    const configuracion = await configuracionDe(rol);

    expect(configuracion.permisos).toEqual(permisosDe(rol));
  });

  test("sigue trayendo lo de antes (HU-8, HU-4)", async () => {
    const configuracion = await configuracionDe(P);

    expect(configuracion).toMatchObject({
      nombre: expect.any(String),
      moneda: expect.any(String),
      rol: P,
    });
    expect(Array.isArray(configuracion.ubicaciones)).toBe(true);
  });

  test("al empleado no le cuenta lo que pueden los demas", async () => {
    const { permisos } = await configuracionDe(E);

    expect(permisos).not.toHaveProperty("auditoria");
    expect(permisos).not.toHaveProperty("member");
    expect(permisos.producto).toEqual(["read"]);
  });

  test("lo que informa coincide con lo que deja hacer la API", async () => {
    const { permisos } = await configuracionDe(E);

    // Dice que no puede crear productos...
    expect(permisos.producto).not.toContain("create");

    // ...y efectivamente no puede.
    const intento = await pedir("POST", "/api/productos", sesiones[E].cookie);

    expect(intento.status).toBe(403);

    // Lo que si dice que puede, la puerta lo deja pasar.
    expect(permisos.movimiento).toContain("read");

    const permitido = await pedir("GET", "/api/movimientos", sesiones[E].cookie);

    expect(permitido.status).toBe(200);
  });
});

// --- 3. Plugin de organizacion de Better Auth -------------------------------

const ENDPOINTS_DE_ORGANIZACION = [
  // Solo pedian ser miembro: el empleado veia el equipo por aca.
  ["GET", "/api/auth/organization/list-members"],
  ["GET", "/api/auth/organization/get-full-organization"],
  ["GET", "/api/auth/organization/list-invitations"],
  // Pedian permisos heredados del plugin, no de nuestra matriz.
  ["POST", "/api/auth/organization/update"],
  ["POST", "/api/auth/organization/delete"],
  ["POST", "/api/auth/organization/update-member-role"],
  ["POST", "/api/auth/organization/remove-member"],
  ["POST", "/api/auth/organization/invite-member"],
  ["POST", "/api/auth/organization/leave"],
  ["POST", "/api/auth/organization/set-active"],
  ["POST", "/api/auth/organization/create"],
];

describe("Endpoints de organizacion de Better Auth", () => {
  describe.each(ENDPOINTS_DE_ORGANIZACION)("%s %s", (metodo, ruta) => {
    test.each([P, G, E])("cerrado para %s", async (rol) => {
      const respuesta = await pedir(metodo, ruta, sesiones[rol].cookie);

      expect(respuesta.status).toBe(403);
      expect(respuesta.body).toEqual({ error: SIN_PERMISO });
    });
  });

  test("el empleado no puede sacar el id de su organizacion y listar el equipo", async () => {
    // Es el camino que funcionaba antes de HU-32: `organization/list` le da a
    // cualquier miembro el id de su organizacion, y `list-members` lo acepta
    // por query string y solo verifica que sea miembro, no su rol.
    const [fila] = await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, sesiones[E].email));

    const equipo = await request(app)
      .get("/api/auth/organization/list-members")
      .query({ organizationId: fila.organizationId })
      .set("Cookie", sesiones[E].cookie);

    expect(JSON.stringify(equipo.body)).not.toContain(sesiones[P].email);
    expect(equipo.status).toBe(403);

    const organizaciones = await request(app)
      .get("/api/auth/organization/list")
      .set("Cookie", sesiones[E].cookie);

    expect(organizaciones.status).toBe(403);
  });

  test.each([
    "/api/auth/organization/list-members",
    "/api/auth//organization/list-members",
    "/api/auth/Organization/list-members",
    "/api/auth/ORGANIZATION/list-members",
    "/api/auth/organization%2Flist-members",
    "/api/auth/%6Frganization/list-members",
    "/api/auth/x/../organization/list-members",
    "/api/auth/x/%2E%2E/organization/list-members",
    // Suben por encima del montaje y vuelven a bajar: `req.path` no lo ve,
    // pero Better Auth resuelve la URL completa y llega al endpoint.
    "/api/auth/../auth/organization/list-members",
    "/api/auth/%2e%2e/auth/organization/list-members",
    "/api/auth/x/../../auth/organization/list-members",
  ])("el empleado no ve el equipo pidiendo %s", async (ruta) => {
    const [fila] = await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, sesiones[E].email));

    // Con el id explícito: sin él `list-members` da 400 por no haber
    // organización activa, y el test pasaría sin probar nada. Y por HTTP
    // crudo, no con supertest: supertest resuelve los `..` antes de mandar,
    // y el caso que importa es justo el que llega sin resolver.
    const respuesta = await pedirCrudo(
      `${ruta}?organizationId=${fila.organizationId}`,
      sesiones[E].cookie,
    );

    expect(respuesta.cuerpo).not.toContain(sesiones[P].email);
    expect(respuesta.status).toBe(403);
    expect(JSON.parse(respuesta.cuerpo)).toEqual({ error: SIN_PERMISO });
  });

  test("despues de intentar borrar la organizacion, el comercio sigue andando", async () => {
    await request(app)
      .post("/api/auth/organization/delete")
      .set("Cookie", sesiones[P].cookie)
      .send({});

    const sigue = await request(app)
      .get("/api/comercio")
      .set("Cookie", sesiones[P].cookie);

    expect(sigue.status).toBe(200);
  });

  test("el resto de Better Auth sigue abierto: la sesion se lee", async () => {
    const respuesta = await request(app)
      .get("/api/auth/get-session")
      .set("Cookie", sesiones[E].cookie);

    expect(respuesta.status).toBe(200);
    expect(respuesta.body.user.email).toBe(sesiones[E].email);
  });

  test("y el login funciona", async () => {
    const respuesta = await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: sesiones[G].email, password: PASSWORD });

    expect(respuesta.status).toBe(200);
  });
});
