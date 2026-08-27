import "dotenv/config";
import express from "express";
import cors from "cors";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";

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
 * /api/auth/{ruta}:
 *   post:
 *     summary: Endpoints de autenticacion gestionados por Better Auth
 *     description: >
 *       Better Auth expone aca todo el ciclo de sesion (registro, login,
 *       logout, recuperacion de contrasena) y los endpoints de organizacion.
 *       El catalogo completo y actualizado esta en `/api/auth/reference`.
 *     tags: [Auth]
 *     parameters:
 *       - in: path
 *         name: ruta
 *         required: true
 *         schema: { type: string }
 *         description: "Ruta interna de Better Auth, por ejemplo: sign-up/email"
 *     responses:
 *       200:
 *         description: Respuesta del endpoint de Better Auth
 */
// Va montado ANTES de express.json(): Better Auth necesita leer el body crudo.
// Si se invierte el orden, todos los POST de auth fallan sin error claro.
app.all("/api/auth/*", toNodeHandler(auth));

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

// Manejador de errores: cierra la cadena para que un throw en un service no
// deje la request colgada. Va siempre ultimo.
app.use((error, req, res, _next) => {
  const status = error.status || error.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? "Error interno del servidor" : error.message,
  });
});
