import { Router } from "express";
import * as controller from "../controllers/ubicaciones.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` en `req`,
// que es lo que hace que cada comercio vea solo lo suyo.
router.use(requireAuth);

/**
 * @openapi
 * /api/ubicaciones:
 *   get:
 *     summary: Lista las ubicaciones de stock del comercio (HU-8)
 *     description: >
 *       Devuelve las ubicaciones del comercio de la sesión, ordenadas por
 *       nombre. Las puede leer cualquier rol, porque registrar un movimiento
 *       requiere elegir una.
 *     tags: [Configuración]
 *     responses:
 *       200:
 *         description: Listado de ubicaciones
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string, format: uuid }
 *                   nombre: { type: string, example: Depósito }
 *       401:
 *         description: No hay sesión activa
 */
router.get(
  "/",
  requirePermission({ ubicacion: ["read"] }),
  controller.listar,
);

/**
 * @openapi
 * /api/ubicaciones:
 *   post:
 *     summary: Crea una ubicación de stock (HU-8)
 *     tags: [Configuración]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, example: Depósito }
 *     responses:
 *       201:
 *         description: Ubicación creada
 *       400:
 *         description: El nombre falta o es demasiado largo
 *       403:
 *         description: El rol no puede crear ubicaciones
 *       409:
 *         description: Ya existe una ubicación con ese nombre en el comercio
 */
router.post(
  "/",
  requirePermission({ ubicacion: ["create"] }),
  controller.crear,
);

/**
 * @openapi
 * /api/ubicaciones/{id}:
 *   put:
 *     summary: Renombra una ubicación (HU-8)
 *     tags: [Configuración]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string }
 *     responses:
 *       200:
 *         description: Ubicación actualizada
 *       404:
 *         description: La ubicación no existe en este comercio
 *       409:
 *         description: Ya existe otra ubicación con ese nombre
 */
router.put(
  "/:id",
  requirePermission({ ubicacion: ["update"] }),
  controller.renombrar,
);

/**
 * @openapi
 * /api/ubicaciones/{id}:
 *   delete:
 *     summary: Elimina una ubicación (HU-8)
 *     tags: [Configuración]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Ubicación eliminada
 *       403:
 *         description: El rol no puede eliminar ubicaciones
 *       404:
 *         description: La ubicación no existe en este comercio
 */
router.delete(
  "/:id",
  requirePermission({ ubicacion: ["delete"] }),
  controller.eliminar,
);

export default router;
