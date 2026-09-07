import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { auditarCambios } from "./middlewares/auditoria.middleware.js";
import comerciosRoutes from "./routes/comercios.routes.js";
import auditoriaRoutes from "./routes/auditoria.routes.js";
import configuracionRoutes from "./routes/configuracion.routes.js";
import datosPersonalesRoutes from "./routes/datosPersonales.routes.js";
import invitacionesRoutes from "./routes/invitaciones.routes.js";
import miembrosRoutes from "./routes/miembros.routes.js";
import movimientosRoutes from "./routes/movimientos.routes.js";
import productosRoutes from "./routes/productos.routes.js";
import ubicacionesRoutes from "./routes/ubicaciones.routes.js";

export const app = express();

const origenesPermitidos = (
  process.env.TRUSTED_ORIGINS || "http://localhost:5173"
)
  .split(",")
  .map((origen) => origen.trim())
  .filter(Boolean);

/**
 * Cabeceras de seguridad (HU-31, RNF4).
 *
 * Va antes que todo lo demas para que aplique tambien a las respuestas de
 * error. Lo mas importante que aporta:
 *
 * - HSTS: le dice al navegador que a este dominio solo se entra por HTTPS,
 *   aunque el usuario escriba http://. Sin esto, el primer pedido de cada
 *   visita puede viajar en claro.
 * - `X-Content-Type-Options: nosniff`: evita que el navegador adivine el tipo
 *   de un archivo e interprete como script algo que no lo es.
 * - Se oculta `X-Powered-By`, que hoy anuncia "Express" a cualquiera.
 *
 * `contentSecurityPolicy` queda apagado porque esta API no sirve HTML: la CSP
 * la define el Frontend, que es quien lo hace. Y `crossOriginResourcePolicy`
 * se abre porque el Frontend vive en otro origen en produccion.
 */
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// `credentials: true` es obligatorio: la sesion de Better Auth viaja en cookie,
// y sin esto el navegador no la manda desde el Frontend.
app.use(cors({ origin: origenesPermitidos, credentials: true }));

/**
 * @openapi
 * /api/auth/sign-up/email:
 *   post:
 *     summary: Registro de un usuario propietario (HU-1)
 *     description: >
 *       Crea la cuenta y, en la misma operacion, todo lo que hace falta para
 *       que el usuario sea propietario de un comercio: la `organization` que
 *       actua de tenant, la fila en `member` con rol `propietario` (RF9) y el
 *       `comercio` con datos por defecto, que se completan luego en HU-6.
 *
 *
 *       La contrasena se guarda con hash bcrypt de 12 rondas, nunca en texto
 *       plano (RNF4). El registro deja la sesion iniciada.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Comercio de Ana
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 minLength: 8
 *     responses:
 *       200:
 *         description: Cuenta creada. Devuelve el usuario y setea la cookie de sesion.
 *       422:
 *         description: >
 *           El correo ya esta registrado
 *           (`USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`).
 *
 * /api/auth/sign-in/email:
 *   post:
 *     summary: Inicio de sesion (HU-2)
 *     description: >
 *       Valida las credenciales y devuelve una cookie de sesion HttpOnly.
 *
 *
 *       La sesion caduca por inactividad: vive 8 horas desde la ultima
 *       actividad y se renueva como mucho una vez por hora mientras se sigue
 *       usando la app.
 *
 *
 *       Un correo inexistente y una contrasena incorrecta devuelven la misma
 *       respuesta, para que no se pueda averiguar que correos estan
 *       registrados probando de a uno.
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Sesion iniciada. Devuelve el usuario y setea la cookie.
 *       401:
 *         description: Credenciales invalidas.
 *
 * /api/auth/sign-out:
 *   post:
 *     summary: Cierre de sesion (HU-2)
 *     description: Invalida la sesion actual y borra la cookie.
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Sesion cerrada.
 *
 * /api/auth/{ruta}:
 *   post:
 *     summary: Resto de los endpoints de autenticacion (Better Auth)
 *     description: >
 *       Better Auth expone aca el resto del ciclo de sesion (login, logout,
 *       recuperacion de contrasena) y los endpoints de organizacion.
 *     tags: [Auth]
 *     parameters:
 *       - in: path
 *         name: ruta
 *         required: true
 *         schema: { type: string }
 *         description: "Ruta interna de Better Auth, por ejemplo: sign-in/email"
 *     responses:
 *       200:
 *         description: Respuesta del endpoint de Better Auth
 */
// Va montado ANTES de express.json(): Better Auth necesita leer el body crudo.
// Si se invierte el orden, todos los POST de auth fallan sin error claro.
app.all("/api/auth/{*any}", toNodeHandler(auth));

app.use(express.json());

const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "API — Gestión Comercial PyME",
      version: "1.0.0",
      description: "Documentación de la API del backend",
    },
    // Un solo servidor a proposito.
    //
    // Antes habia dos ("/" directo y "/api" por Nginx) porque el proxy
    // strippeaba el prefijo /api y las rutas terminaban siendo distintas en
    // cada entorno. Con el proxy_pass sin barra final (ver el PR de
    // Infraestructura) las URLs son identicas con y sin Docker, asi que una
    // sola entrada alcanza. Si se volvieran a poner las dos, elegir "/api"
    // convertiria /api/auth/x en /api/api/auth/x y daria 404.
    servers: [{ url: "/", description: "Base de la API" }],
  },
  apis: ["./src/app.js", "./src/routes/*.js"],
});

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Chequeo de salud del servidor
 *     responses:
 *       200:
 *         description: El servidor está funcionando
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Van montadas en /api porque cada una define su propia ruta completa
// (/mis-datos, /mi-cuenta): son de la persona, no de un recurso del comercio.
//
// Quedan ARRIBA de `auditarCambios`, y eso es a proposito. `DELETE
// /api/mi-cuenta` anonimiza la auditoria de esa persona; si ademas pasara por
// el middleware, al terminar la respuesta se escribiria un evento nuevo con su
// correo real y volveria a entrar el dato que se acaba de borrar. La baja
// quedaria registrada dejando rastro de quien la pidio, que es exactamente lo
// contrario de lo que pide el derecho de supresion (HU-31, Ley 25.326).
app.use("/api", datosPersonalesRoutes);

// Va antes de TODAS las rutas de negocio: engancha el final de cada respuesta
// para dejar constancia de lo que cambio (HU-5). Cubre tambien los endpoints
// que agreguen los demas, sin que tengan que acordarse de llamarlo.
//
// El orden importa y es facil de romper sin darse cuenta: lo que se monte
// arriba de esta linea queda sin auditar. Al mergear HU-4, git dejo estas
// rutas por encima sin marcar conflicto, y eso habria dejado justamente las
// operaciones sobre personas —invitar, cambiar un rol, quitar a alguien— fuera
// del registro. Cualquier ruta nueva va DEBAJO.
app.use(auditarCambios);

app.use("/api/miembros", miembrosRoutes);
app.use("/api/invitaciones", invitacionesRoutes);
app.use("/api/comercio", comerciosRoutes);
app.use("/api/auditoria", auditoriaRoutes);
app.use("/api/ubicaciones", ubicacionesRoutes);
app.use("/api/configuracion", configuracionRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/movimientos", movimientosRoutes);

// Manejador de errores: cierra la cadena para que un throw en un service no
// deje la request colgada. Va siempre ultimo.
//
// Los errores de negocio traen su propio `status` y su mensaje se devuelve tal
// cual. Un 500 es un bug: se loguea entero para poder diagnosticarlo, pero al
// cliente se le manda un mensaje generico para no filtrar detalles internos.
app.use((error, req, res, _next) => {
  const status = error.status || error.statusCode || 500;

  if (status === 500) {
    console.error(`[${req.method} ${req.originalUrl}]`, error);
  }

  res.status(status).json({
    error: status === 500 ? "Error interno del servidor" : error.message,
  });
});
