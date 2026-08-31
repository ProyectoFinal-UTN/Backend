import { Router } from "express";
import * as controller from "../controllers/configuracion.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/configuracion:
 *   get:
 *     summary: Parámetros generales del negocio (HU-8)
 *     description: >
 *       Devuelve la moneda y las ubicaciones de stock del comercio de la
 *       sesión, para que el resto de los módulos los lean de un solo lugar.
 *     tags: [Configuración]
 *     responses:
 *       200:
 *         description: Configuración del comercio
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nombre: { type: string }
 *                 moneda: { type: string, example: ARS }
 *                 ubicaciones:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       nombre: { type: string }
 *       401:
 *         description: No hay sesión activa
 */
router.get("/", requirePermission({ comercio: ["read"] }), controller.ver);

/**
 * @openapi
 * /api/configuracion/moneda:
 *   put:
 *     summary: Cambia la moneda del comercio (HU-8)
 *     description: Solo el propietario puede cambiarla.
 *     tags: [Configuración]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [moneda]
 *             properties:
 *               moneda:
 *                 type: string
 *                 enum: [ARS, USD, EUR, BRL, CLP, UYU]
 *     responses:
 *       200:
 *         description: Moneda actualizada
 *       400:
 *         description: Moneda no aceptada
 *       403:
 *         description: El rol no puede cambiar la configuración del comercio
 */
router.put(
  "/moneda",
  requirePermission({ comercio: ["update"] }),
  controller.cambiarMoneda,
);

export default router;
