import { Router } from "express";
import * as controller from "../controllers/asistente.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` en `req`, que
// es lo único sobre lo que el asistente puede consultar.
router.use(requireAuth);

/**
 * @openapi
 * /api/asistente/consultas:
 *   post:
 *     summary: Consulta en lenguaje natural sobre los datos del comercio (HU-26)
 *     description: >
 *       Recibe una pregunta escrita como la diría un comerciante ("¿qué tengo
 *       que reponer?", "¿cuánta harina me queda?") y devuelve la respuesta en
 *       texto.
 *
 *
 *       El modelo de lenguaje **no calcula los números**: elige cuál de las
 *       consultas disponibles correr y con qué argumentos, y el sistema las
 *       resuelve en SQL. Las consultas filtran siempre por el comercio de la
 *       sesión, que el modelo no puede ver ni elegir.
 *
 *
 *       Si el proveedor del modelo falla o tarda más de 4 segundos, la
 *       respuesta se arma por reglas (HU-28) y sale con `modo` en `limitado`.
 *       Eso **no** es un error: el status sigue siendo 200 y la pantalla avisa
 *       que la respuesta es limitada. Un 5xx acá significa otra cosa.
 *
 *
 *       Todavía no puede responder sobre proveedores ni precios: la tabla
 *       PROVEEDOR llega con HU-19.
 *     tags: [Asistente]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pregunta]
 *             properties:
 *               pregunta:
 *                 type: string
 *                 maxLength: 500
 *                 example: ¿Qué productos tengo que reponer?
 *     responses:
 *       200:
 *         description: La respuesta del asistente.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 respuesta:
 *                   type: string
 *                   example: Tenés tres productos para reponer: harina 000 (te quedan 2 kg, el mínimo es 10), yerba (0 de 5) y azúcar (1 de 6).
 *                 modo:
 *                   type: string
 *                   enum: [ia, limitado]
 *                   description: >
 *                     `ia` si la armó el modelo con los datos del comercio.
 *                     `limitado` si el proveedor no estaba disponible y se
 *                     respondió por reglas (HU-28).
 *                 herramientasUsadas:
 *                   type: array
 *                   description: Qué consultas se corrieron para armar la respuesta. Vacío en modo limitado.
 *                   items:
 *                     type: string
 *                   example: [productosParaReponer]
 *       400:
 *         description: La pregunta está vacía o supera los 500 caracteres.
 *       401:
 *         description: No hay sesión activa.
 *       403:
 *         description: El rol no tiene permiso para usar el asistente.
 */
router.post(
  "/consultas",
  requirePermission({ asistente: ["consultar"] }),
  controller.consultar,
);

export default router;
