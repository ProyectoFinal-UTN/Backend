import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import { eq, inArray, like } from "drizzle-orm";
import { app } from "../src/app.js";
import { cerrarConexion, db } from "../src/db/client.js";
import {
  comercio,
  invitation,
  member,
  movimiento,
  organization,
  user,
} from "../src/db/schema.js";
import { SIN_PERMISO } from "../src/middlewares/auth.middleware.js";
import { leerPdf, tieneFormaDePdf } from "./pdf.helper.js";

/**
 * Test de integracion de HU-25 (reportes de movimientos en PDF).
 *
 * Corre contra la base real, igual que tests/comprasProveedor.test.js. Arma un
 * comercio con nombre con tildes y ñ, dos productos y dos proveedores, y
 * movimientos en fechas conocidas (uno en agosto y cuatro en septiembre), mas
 * un segundo comercio que el primero nunca tiene que ver. Despues descarga los
 * PDF por HTTP, los abre con un parser real y verifica lo que dicen.
 *
 * Cada movimiento cae en un dia distinto a proposito: la fecha impresa en la
 * tabla es lo que permite decir que fila entro y cual no.
 */

const SUFIJO = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const correo = (etiqueta) => `test-hu25-${etiqueta}-${SUFIJO}@test.local`;
const PASSWORD = "unaClaveSegura123";

const NOMBRE_COMERCIO = "Almacén Doña Ñata";
const ID_INEXISTENTE = "123e4567-e89b-12d3-a456-426614174999";

// Septiembre entero en hora argentina (UTC-3), con los dos limites inclusivos.
const SEPTIEMBRE = {
  desde: "2026-09-01T03:00:00.000Z",
  hasta: "2026-10-01T02:59:59.999Z",
};
const AGOSTO_Y_SEPTIEMBRE = {
  desde: "2026-08-01T03:00:00.000Z",
  hasta: SEPTIEMBRE.hasta,
};
const UN_ANIO_SIN_NADA = {
  desde: "2025-01-01T03:00:00.000Z",
  hasta: "2026-01-01T02:59:59.999Z",
};

// Las 15:00 UTC son las 12:00 en Argentina: es la hora que imprime el PDF.
const FECHAS = {
  compraCafeAgosto: new Date("2026-08-10T15:00:00.000Z"),
  ventaCafe: new Date("2026-09-05T15:00:00.000Z"),
  compraYerba: new Date("2026-09-10T15:00:00.000Z"),
  compraCafe: new Date("2026-09-12T15:00:00.000Z"),
  mermaYerba: new Date("2026-09-20T15:00:00.000Z"),
  compraDeB: new Date("2026-09-15T15:00:00.000Z"),
};

let contadorCodigo = 0;
function codigoBarras() {
  contadorCodigo += 1;
  return `77925${Date.now().toString().slice(-6)}${contadorCodigo}`.slice(0, 13);
}

function cookiesDe(respuesta) {
  return (respuesta.headers["set-cookie"] ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function registrar(etiqueta, invitacionId) {
  const email = correo(etiqueta);

  const respuesta = await request(app)
    .post("/api/auth/sign-up/email")
    .send({
      name: `Usuario ${etiqueta}`,
      email,
      password: PASSWORD,
      ...(invitacionId ? { invitacionId } : {}),
    });

  if (respuesta.status !== 200) {
    throw new Error(`No se pudo registrar a ${etiqueta}: ${respuesta.status}`);
  }

  return { email, cookie: cookiesDe(respuesta) };
}

/** Suma a alguien al comercio de A con el rol pedido (HU-4). */
async function sumarAlEquipo(etiqueta, rol) {
  const invitacion = await request(app)
    .post("/api/miembros/invitaciones")
    .set("Cookie", sesiones.propietario.cookie)
    .send({ correo: correo(etiqueta), rol });

  if (invitacion.status !== 201) {
    throw new Error(`No se pudo invitar a ${etiqueta}: ${invitacion.status}`);
  }

  return registrar(etiqueta, invitacion.body.id);
}

async function crear(cookie, ruta, datos) {
  const respuesta = await request(app)
    .post(ruta)
    .set("Cookie", cookie)
    .send(datos);

  if (respuesta.status !== 201) {
    throw new Error(`POST ${ruta} respondió ${respuesta.status}`);
  }

  return respuesta.body;
}

const crearProducto = (cookie, nombre) =>
  crear(cookie, "/api/productos", {
    nombre,
    codigoBarras: codigoBarras(),
    categoria: "Almacén",
    unidadMedida: "unidad",
    umbralMinimo: 0,
    stockActual: 50,
  });

/** Registra un movimiento y lo corre a la fecha pedida (fixture, como HU-21). */
async function registrarEn(cookie, fecha, datos) {
  const { movimiento: creado } = await crear(cookie, "/api/movimientos", datos);

  await db
    .update(movimiento)
    .set({ fecha })
    .where(eq(movimiento.id, creado.id));

  return creado.id;
}

/** Junta el cuerpo binario: supertest no bufferea `application/pdf` solo. */
function juntarBinario(respuesta, listo) {
  const partes = [];
  respuesta.on("data", (parte) => partes.push(parte));
  respuesta.on("end", () => listo(null, Buffer.concat(partes)));
}

function pedirReporte(cookie, query) {
  const pedido = request(app)
    .get("/api/reportes/movimientos")
    .query(query)
    .buffer(true)
    .parse(juntarBinario);

  return cookie ? pedido.set("Cookie", cookie) : pedido;
}

/** Los errores vuelven como JSON, pero el parser binario los deja en Buffer. */
const errorDe = (respuesta) => JSON.parse(respuesta.body.toString("utf8"));

/** Pide el reporte, exige un 200 con PDF y devuelve su texto. */
async function textoDelReporte(cookie, query) {
  const respuesta = await pedirReporte(cookie, query);

  expect(respuesta.status).toBe(200);
  return (await leerPdf(respuesta.body)).texto;
}

const sesiones = {};
let comercioB;
let cafe;
let yerba;
let proveedorX;
let proveedorY;
let productoDeB;
let proveedorDeB;

/**
 * Tres registros con bcrypt de 12 rondas, dos invitaciones y una docena de
 * escrituras contra Neon: no entra en los 30 s de `testTimeout`, asi que el
 * hook lleva el suyo, igual que en tests/comprasProveedor.test.js.
 */
const TIMEOUT_FIXTURE = 120000;

beforeAll(async () => {
  sesiones.propietario = await registrar("dueno");
  sesiones.gerente = await sumarAlEquipo("encargado", "gerente");
  sesiones.empleado = await sumarAlEquipo("cajero", "empleado");
  comercioB = await registrar("otro");

  const perfil = await request(app)
    .put("/api/comercio")
    .set("Cookie", sesiones.propietario.cookie)
    .send({ nombre: NOMBRE_COMERCIO, rubro: "Almacén" });
  if (perfil.status !== 200) {
    throw new Error(`No se pudo cargar el perfil: ${perfil.status}`);
  }

  const cookieA = sesiones.propietario.cookie;

  proveedorX = (
    await crear(cookieA, "/api/proveedores", { nombre: "Distribuidora Peñalolén" })
  ).id;
  proveedorY = (
    await crear(cookieA, "/api/proveedores", { nombre: "Lácteos del Sur" })
  ).id;

  // Cada alta deja su ajuste inicial con la fecha de hoy: cae fuera de los
  // rangos de agosto y septiembre que se piden en los tests.
  cafe = await crearProducto(cookieA, "Café molido");
  yerba = await crearProducto(cookieA, "Yerba Ñandú 1kg");

  await registrarEn(cookieA, FECHAS.compraCafeAgosto, {
    productoId: cafe.id,
    tipo: "compra",
    cantidad: 5,
    proveedorId: proveedorX,
  });
  await registrarEn(cookieA, FECHAS.ventaCafe, {
    productoId: cafe.id,
    tipo: "venta",
    cantidad: 2,
  });
  await registrarEn(cookieA, FECHAS.compraYerba, {
    productoId: yerba.id,
    tipo: "compra",
    cantidad: 7,
    proveedorId: proveedorY,
  });
  await registrarEn(cookieA, FECHAS.compraCafe, {
    productoId: cafe.id,
    tipo: "compra",
    cantidad: 3,
    proveedorId: proveedorX,
  });
  await registrarEn(cookieA, FECHAS.mermaYerba, {
    productoId: yerba.id,
    tipo: "merma",
    cantidad: 1,
    motivo: "Paquete roto",
  });

  // --- Comercio B, en el mismo rango, que A nunca tiene que ver ------------
  productoDeB = await crearProducto(comercioB.cookie, "Producto Secreto de B");
  proveedorDeB = (
    await crear(comercioB.cookie, "/api/proveedores", {
      nombre: "Proveedor Secreto de B",
    })
  ).id;
  await registrarEn(comercioB.cookie, FECHAS.compraDeB, {
    productoId: productoDeB.id,
    tipo: "compra",
    cantidad: 9,
    proveedorId: proveedorDeB,
  });
}, TIMEOUT_FIXTURE);

afterAll(async () => {
  const patron = `%-${SUFIJO}@test.local`;

  const creadas = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(like(user.email, patron));

  const ids = [...new Set(creadas.map((fila) => fila.organizationId))];

  // El comercio antes que el usuario, porque `movimiento.usuario_id` es
  // `restrict`; las invitaciones antes que la organizacion.
  if (ids.length > 0) {
    await db.delete(invitation).where(inArray(invitation.organizationId, ids));
    await db.delete(comercio).where(inArray(comercio.organizationId, ids));
  }

  await db.delete(user).where(like(user.email, patron));

  if (ids.length > 0) {
    await db.delete(organization).where(inArray(organization.id, ids));
  }

  await cerrarConexion();
}, TIMEOUT_FIXTURE);

describe("GET /api/reportes/movimientos — el PDF es válido", () => {
  let respuesta;

  beforeAll(async () => {
    respuesta = await pedirReporte(sesiones.propietario.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
    });
  });

  test("responde 200 con content-type application/pdf", () => {
    expect(respuesta.status).toBe(200);
    expect(respuesta.headers["content-type"]).toMatch(/^application\/pdf/);
  });

  test("el cuerpo empieza con %PDF- y cierra con %%EOF", () => {
    expect(tieneFormaDePdf(respuesta.body)).toBe(true);
  });

  test("un parser real lo abre", async () => {
    const { paginas } = await leerPdf(respuesta.body);

    expect(paginas).toBeGreaterThanOrEqual(1);
  });

  test("se descarga como adjunto con nombre de archivo", () => {
    expect(respuesta.headers["content-disposition"]).toBe(
      'attachment; filename="reporte-movimientos-periodo-2026-09-01_2026-09-30.pdf"',
    );
  });

  test("Content-Length coincide con el archivo", () => {
    expect(Number(respuesta.headers["content-length"])).toBe(
      respuesta.body.length,
    );
  });

  test("no se guarda en caché y el front puede leer el nombre por CORS", () => {
    expect(respuesta.headers["cache-control"]).toBe("no-store");
    expect(respuesta.headers["access-control-expose-headers"]).toContain(
      "Content-Disposition",
    );
  });
});

describe("encabezado del reporte", () => {
  let texto;

  beforeAll(async () => {
    texto = await textoDelReporte(sesiones.propietario.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
    });
  });

  test("trae el nombre del comercio con sus tildes y ñ", () => {
    expect(texto).toContain(NOMBRE_COMERCIO);
  });

  test("trae la fecha y hora de generación", () => {
    expect(texto).toMatch(
      /Fecha de generación: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/,
    );
  });

  test("trae el tipo y el rango aplicado en hora local", () => {
    expect(texto).toContain("Reporte de movimientos por período");
    expect(texto).toContain("Tipo de reporte: Por período");
    expect(texto).toContain(
      "Rango aplicado: 01/09/2026 00:00 al 30/09/2026 23:59 (hora de America/Argentina/Buenos_Aires)",
    );
  });

  test("numera las páginas y aclara que no hay montos", () => {
    expect(texto).toContain("Página 1 de 1");
    expect(texto).toContain("Montos no disponibles");
  });
});

describe("filtro por período", () => {
  let texto;

  beforeAll(async () => {
    texto = await textoDelReporte(sesiones.gerente.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
    });
  });

  test("trae los cuatro movimientos de septiembre, con producto y proveedor", () => {
    expect(texto).toContain("05/09/2026 12:00 Venta Café molido");
    expect(texto).toContain("10/09/2026 12:00 Compra Yerba Ñandú 1kg");
    expect(texto).toContain("Lácteos del Sur");
    // El nombre del proveedor no entra en el ancho de su columna y la celda
    // baja de renglón: se compara con los espacios normalizados.
    expect(texto.replace(/\s+/g, " ")).toContain(
      "12/09/2026 12:00 Compra Café molido Principal +3 Distribuidora Peñalolén",
    );
    expect(texto).toContain("20/09/2026 12:00 Merma Yerba Ñandú 1kg");
  });

  test("deja afuera lo que pasó fuera del rango", () => {
    expect(texto).not.toContain("10/08/2026");
  });

  test("los totales son los del rango", () => {
    expect(texto).toContain("Movimientos: 4");
    expect(texto).toContain("Unidades que entraron: 10");
    expect(texto).toContain("Unidades que salieron: 3");
    expect(texto).toContain("Saldo neto: +7");
    expect(texto).toContain("Compras: 2 movimientos, +10 unidades");
    expect(texto).toContain("Ventas: 1 movimiento, -2 unidades");
    expect(texto).toContain("Mermas: 1 movimiento, -1 unidades");
  });

  test("ordena del más viejo al más nuevo", () => {
    const posiciones = ["05/09", "10/09", "12/09", "20/09"].map((dia) =>
      texto.indexOf(`${dia}/2026 12:00`),
    );

    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
  });

  test("la zona horaria cambia cómo se imprimen las horas", async () => {
    const enUtc = await textoDelReporte(sesiones.gerente.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
      zonaHoraria: "UTC",
    });

    expect(enUtc).toContain("05/09/2026 15:00 Venta Café molido");
  });
});

describe("filtro por producto", () => {
  test("trae solo los movimientos de ese producto en el rango", async () => {
    const texto = await textoDelReporte(sesiones.propietario.cookie, {
      tipo: "producto",
      productoId: cafe.id,
      ...SEPTIEMBRE,
    });

    expect(texto).toContain("Reporte de movimientos por producto");
    expect(texto).toContain("Producto: Café molido — código");
    expect(texto).toContain("05/09/2026 12:00 Venta");
    expect(texto).toContain("12/09/2026 12:00 Compra");
    expect(texto).not.toContain("10/09/2026");
    expect(texto).not.toContain("20/09/2026");
    expect(texto).not.toContain("Yerba");
    expect(texto).toContain("Movimientos: 2");
    expect(texto).toContain("Saldo neto: +1");
  });

  test("el rango sigue mandando: con agosto entra la compra vieja", async () => {
    const texto = await textoDelReporte(sesiones.propietario.cookie, {
      tipo: "producto",
      productoId: cafe.id,
      ...AGOSTO_Y_SEPTIEMBRE,
    });

    expect(texto).toContain("10/08/2026 12:00 Compra");
    expect(texto).toContain("Movimientos: 3");
  });

  test("el nombre del archivo lleva el producto", async () => {
    const respuesta = await pedirReporte(sesiones.propietario.cookie, {
      tipo: "producto",
      productoId: yerba.id,
      ...SEPTIEMBRE,
    });

    expect(respuesta.headers["content-disposition"]).toBe(
      'attachment; filename="reporte-movimientos-producto-yerba-nandu-1kg-2026-09-01_2026-09-30.pdf"',
    );
  });
});

describe("filtro por proveedor", () => {
  test("trae solo lo que se le compró a ese proveedor en el rango", async () => {
    const texto = await textoDelReporte(sesiones.propietario.cookie, {
      tipo: "proveedor",
      proveedorId: proveedorX,
      ...SEPTIEMBRE,
    });

    expect(texto).toContain("Reporte de movimientos por proveedor");
    expect(texto).toContain("Proveedor: Distribuidora Peñalolén");
    expect(texto).toContain("12/09/2026 12:00 Compra Café molido");
    // La compra de agosto a X queda afuera por el rango; la de Y, por el
    // proveedor; la venta y la merma no tienen proveedor.
    expect(texto).not.toContain("10/08/2026");
    expect(texto).not.toContain("10/09/2026");
    expect(texto).not.toContain("Venta");
    expect(texto).toContain("Movimientos: 1");
  });
});

describe("sin movimientos en el rango", () => {
  test("responde 200 con un PDF que lo dice, no con un error", async () => {
    const respuesta = await pedirReporte(sesiones.propietario.cookie, {
      tipo: "periodo",
      ...UN_ANIO_SIN_NADA,
    });

    expect(respuesta.status).toBe(200);
    expect(tieneFormaDePdf(respuesta.body)).toBe(true);

    const { texto } = await leerPdf(respuesta.body);
    expect(texto).toContain(
      "No se registraron movimientos en el rango seleccionado.",
    );
    expect(texto).toContain("Movimientos: 0");
    // El encabezado sigue diciendo de quién y de cuándo es.
    expect(texto).toContain(NOMBRE_COMERCIO);
    expect(texto).toContain("Rango aplicado: 01/01/2025 00:00 al 31/12/2025 23:59");
  });
});

describe("validaciones", () => {
  test.each([
    [{ ...SEPTIEMBRE }, 'Falta el parámetro "tipo"'],
    [{ tipo: "semanal", ...SEPTIEMBRE }, "El tipo de reporte no es válido"],
    [{ tipo: "periodo", hasta: SEPTIEMBRE.hasta }, 'Falta el parámetro "desde"'],
    [{ tipo: "periodo", desde: SEPTIEMBRE.desde }, 'Falta el parámetro "hasta"'],
    [
      { tipo: "periodo", desde: "2026-09-01", hasta: SEPTIEMBRE.hasta },
      'El parámetro "desde" debe ser una fecha y hora ISO 8601 con zona',
    ],
    [
      { tipo: "periodo", desde: SEPTIEMBRE.hasta, hasta: SEPTIEMBRE.desde },
      'La fecha "desde" no puede ser posterior a la fecha "hasta"',
    ],
    [{ tipo: "producto", ...SEPTIEMBRE }, 'Falta el parámetro "productoId"'],
    [{ tipo: "proveedor", ...SEPTIEMBRE }, 'Falta el parámetro "proveedorId"'],
    [
      { tipo: "periodo", productoId: ID_INEXISTENTE, ...SEPTIEMBRE },
      'El parámetro "productoId" solo se usa en el reporte por producto',
    ],
    [
      { tipo: "periodo", zonaHoraria: "Marte/Olympus", ...SEPTIEMBRE },
      "La zona horaria no es válida",
    ],
  ])("%j responde 400", async (query, mensaje) => {
    const respuesta = await pedirReporte(sesiones.propietario.cookie, query);

    expect(respuesta.status).toBe(400);
    expect(respuesta.headers["content-type"]).toMatch(/json/);
    expect(errorDe(respuesta).error).toContain(mensaje);
  });

  test.each([
    ["producto", "productoId", ID_INEXISTENTE, "El producto no existe"],
    ["producto", "productoId", "no-es-un-uuid", "El producto no existe"],
    ["proveedor", "proveedorId", ID_INEXISTENTE, "El proveedor no existe"],
    ["proveedor", "proveedorId", "no-es-un-uuid", "El proveedor no existe"],
  ])("tipo %s con %s=%s responde 404", async (tipo, parametro, id, mensaje) => {
    const respuesta = await pedirReporte(sesiones.propietario.cookie, {
      tipo,
      [parametro]: id,
      ...SEPTIEMBRE,
    });

    expect(respuesta.status).toBe(404);
    expect(errorDe(respuesta)).toEqual({ error: mensaje });
  });
});

describe("roles", () => {
  test("sin sesión responde 401", async () => {
    const respuesta = await pedirReporte(null, { tipo: "periodo", ...SEPTIEMBRE });

    expect(respuesta.status).toBe(401);
  });

  test.each(["propietario", "gerente"])("%s descarga el PDF", async (rol) => {
    const respuesta = await pedirReporte(sesiones[rol].cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
    });

    expect(respuesta.status).toBe(200);
    expect(tieneFormaDePdf(respuesta.body)).toBe(true);
  });

  test("el empleado recibe 403 con el mensaje único de HU-32", async () => {
    const respuesta = await pedirReporte(sesiones.empleado.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
    });

    expect(respuesta.status).toBe(403);
    expect(errorDe(respuesta)).toEqual({ error: SIN_PERMISO });
  });
});

describe("aislamiento entre comercios", () => {
  test("el reporte de A no trae nada de B", async () => {
    const texto = await textoDelReporte(sesiones.propietario.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
    });

    expect(texto).not.toContain("Secreto de B");
    expect(texto).not.toContain("15/09/2026");
  });

  test("el reporte de B no trae nada de A", async () => {
    const texto = await textoDelReporte(comercioB.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
    });

    expect(texto).toContain("15/09/2026 12:00 Compra Producto Secreto de B");
    expect(texto).not.toContain("Café molido");
    expect(texto).not.toContain("Yerba");
    expect(texto).not.toContain(NOMBRE_COMERCIO);
    expect(texto).toContain("Movimientos: 1");
  });

  test("A no puede pedir el reporte de un producto de B: 404, como si no existiera", async () => {
    const respuesta = await pedirReporte(sesiones.propietario.cookie, {
      tipo: "producto",
      productoId: productoDeB.id,
      ...SEPTIEMBRE,
    });

    expect(respuesta.status).toBe(404);
    expect(errorDe(respuesta)).toEqual({ error: "El producto no existe" });
  });

  test("A no puede pedir el reporte de un proveedor de B: 404, como si no existiera", async () => {
    const respuesta = await pedirReporte(sesiones.propietario.cookie, {
      tipo: "proveedor",
      proveedorId: proveedorDeB,
      ...SEPTIEMBRE,
    });

    expect(respuesta.status).toBe(404);
    expect(errorDe(respuesta)).toEqual({ error: "El proveedor no existe" });
  });

  test("un comercioId en la query no cambia de comercio", async () => {
    const [{ id: comercioDeB }] = await db
      .select({ id: comercio.id })
      .from(comercio)
      .innerJoin(member, eq(member.organizationId, comercio.organizationId))
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(user.email, comercioB.email));

    const texto = await textoDelReporte(sesiones.propietario.cookie, {
      tipo: "periodo",
      ...SEPTIEMBRE,
      comercioId: comercioDeB,
    });

    expect(texto).toContain(NOMBRE_COMERCIO);
    expect(texto).not.toContain("Secreto de B");
  });
});
