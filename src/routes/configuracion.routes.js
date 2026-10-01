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
 *
 *
 *       Incluye además el `rol` de quien pregunta y sus `permisos` efectivos
 *       (HU-32), para que la pantalla esconda los controles que ese rol no
 *       puede usar sin mantener su propia copia de la matriz de permisos.
 *       **Es solo presentación**: el control real lo hace el backend en cada
 *       endpoint, que responde 403 a quien igual intente la operación.
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
 *                 rol:
 *                   type: string
 *                   enum: [propietario, gerente, empleado]
 *                 permisos:
 *                   type: object
 *                   description: >
 *                     Los permisos del rol de la sesión, y solo esos: un
 *                     empleado no recibe los de un propietario. Se listan
 *                     únicamente los recursos sobre los que el rol tiene
 *                     alguna acción.
 *                   additionalProperties:
 *                     type: array
 *                     items: { type: string }
 *                   example:
 *                     comercio: [read]
 *                     producto: [read]
 *                     ubicacion: [read]
 *                     proveedor: [read]
 *                     movimiento: [create, read]
 *                     transferencia: [create]
 *                     alerta: [read]
 *                     cuenta: [read, delete]
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
