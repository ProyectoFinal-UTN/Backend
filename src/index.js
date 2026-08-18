import "dotenv/config";
import express from "express";
import cors from "cors";
import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares base
app.use(cors());
app.use(express.json());

// Configuración de Swagger
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "API — Gestión Comercial PyME",
      version: "1.0.0",
      description: "Documentación de la API del backend",
    },
    servers: [
      { url: "/", description: "Directo al backend (desarrollo local, sin Nginx)" },
      { url: "/api", description: "A través de Nginx (stack completo con Docker)" },
    ],
  },
  apis: ["./src/index.js", "./src/routes/*.js"], // acá va a buscar los comentarios @openapi de cada ruta
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

app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
  console.log(`Swagger UI disponible en http://localhost:${PORT}/api-docs`);
});