import "dotenv/config";
import express from "express";
import cors from "cors";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import comerciosRoutes from "./routes/comercios.routes.js";
import configuracionRoutes from "./routes/configuracion.routes.js";
import productosRoutes from "./routes/productos.routes.js";
import ubicacionesRoutes from "./routes/ubicaciones.routes.js";

export const app = express();

const origenesPermitidos = (
  process.env.TRUSTED_ORIGINS || "http://localhost:5173"
)
  .split(",")
  .map((origen) => origen.trim())
  .filter(Boolean);

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

app.use("/api/comercio", comerciosRoutes);
app.use("/api/ubicaciones", ubicacionesRoutes);
app.use("/api/configuracion", configuracionRoutes);
app.use("/api/productos", productosRoutes);

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
