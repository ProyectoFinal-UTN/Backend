import { Router } from "express";
import * as controller from "../controllers/comercios.controller.js";
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
 * /api/comercio:
 *   get:
 *     summary: Datos del negocio (HU-6)
 *     description: >
 *       Devuelve el perfil del comercio de la sesión. Lo puede leer cualquier
 *       rol: el nombre del negocio se muestra en pantalla a todos.
 *     tags: [Comercio]
 *     responses:
 *       200:
 *         description: Perfil del comercio
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nombre: { type: string, example: Kiosco Don Pepe }
 *                 rubro: { type: string, example: Kiosco }
 *                 direccion: { type: string, nullable: true }
 *                 telefono: { type: string, nullable: true }
 *                 correoContacto:
 *                   { type: string, format: email, nullable: true }
 *       401:
 *         description: No hay sesión activa
 */
router.get("/", requirePermission({ comercio: ["read"] }), controller.ver);

/**
 * @openapi
 * /api/comercio:
 *   put:
 *     summary: Guarda los datos del negocio (HU-6)
 *     description: >
 *       Solo el propietario puede modificarlos.
 *
 *
 *       `nombre` y `rubro` son obligatorios: sin ellos el comercio queda con
 *       el nombre por defecto que le puso el registro. La dirección y los
 *       datos de contacto son opcionales, pero si se envían tienen que ser
 *       válidos. Un opcional vacío se guarda como `null`, para distinguir
 *       "sin cargar" de "cargado en blanco".
 *
 *
 *       La moneda no se toca por acá: tiene su propio endpoint en
 *       `/api/configuracion/moneda` (HU-8).
 *     tags: [Comercio]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre, rubro]
 *             properties:
 *               nombre: { type: string, maxLength: 150 }
 *               rubro: { type: string, maxLength: 100 }
 *               direccion: { type: string, maxLength: 255, nullable: true }
 *               telefono: { type: string, maxLength: 40, nullable: true }
 *               correoContacto:
 *                 { type: string, format: email, maxLength: 255, nullable: true }
 *     responses:
 *       200:
 *         description: Perfil actualizado
 *       400:
 *         description: Falta un campo obligatorio, o alguno es inválido
 *       403:
 *         description: El rol no puede modificar los datos del comercio
 */
router.put(
  "/",
  requirePermission({ comercio: ["update"] }),
  controller.guardar,
);

export default router;
