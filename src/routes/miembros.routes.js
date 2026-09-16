import { Router } from "express";
import * as controller from "../controllers/miembros.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/miembros:
 *   get:
 *     summary: Equipo del comercio, invitaciones pendientes y roles (HU-4)
 *     description: >
 *       Devuelve en una sola llamada todo lo que necesita la pantalla de
 *       usuarios: quiénes son miembros y con qué rol, qué invitaciones están
 *       sin usar, y los roles asignables con los recursos que alcanza cada uno.
 *
 *
 *       Un empleado recibe 403: no accede a la gestión de usuarios.
 *     tags: [Usuarios]
 *     responses:
 *       200:
 *         description: Equipo del comercio
 *       403:
 *         description: El rol no accede a la gestión de usuarios
 */
router.get("/", requirePermission({ member: ["read"] }), controller.listar);

/**
 * @openapi
 * /api/miembros/invitaciones:
 *   post:
 *     summary: Invita a alguien con un rol (HU-4)
 *     description: >
 *       Crea la invitación y devuelve su id, con el que el frontend arma el
 *       link para compartir. No se envía ningún correo: el propietario pasa el
 *       link como prefiera.
 *
 *
 *       Vence a las 48 horas.
 *     tags: [Usuarios]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [correo, rol]
 *             properties:
 *               correo: { type: string, format: email }
 *               rol:
 *                 type: string
 *                 enum: [propietario, gerente, empleado]
 *     responses:
 *       201:
 *         description: Invitación creada
 *       400:
 *         description: Falta el correo, o el rol no es válido
 *       409:
 *         description: Esa persona ya es parte del comercio
 */
router.post(
  "/invitaciones",
  requirePermission({ invitation: ["create"] }),
  controller.crearInvitacion,
);

/**
 * @openapi
 * /api/miembros/invitaciones/{id}:
 *   delete:
 *     summary: Cancela una invitación pendiente (HU-4)
 *     tags: [Usuarios]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Invitación cancelada
 *       404:
 *         description: No existe o ya no está pendiente
 */
router.delete(
  "/invitaciones/:id",
  requirePermission({ invitation: ["cancel"] }),
  controller.eliminarInvitacion,
);

/**
 * @openapi
 * /api/miembros/{id}/rol:
 *   put:
 *     summary: Cambia el rol de un miembro (HU-4)
 *     description: >
 *       Nadie puede cambiarse el rol a sí mismo, ni bajar al último
 *       propietario: el comercio quedaría sin nadie que pueda administrar
 *       usuarios, y no habría forma de recuperarlo desde la app.
 *     tags: [Usuarios]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rol]
 *             properties:
 *               rol:
 *                 type: string
 *                 enum: [propietario, gerente, empleado]
 *     responses:
 *       200:
 *         description: Rol actualizado
 *       400:
 *         description: Rol inválido, o intento de cambiarse el propio
 *       409:
 *         description: Dejaría al comercio sin propietario
 */
router.put(
  "/:id/rol",
  requirePermission({ member: ["update"] }),
  controller.actualizarRol,
);

/**
 * @openapi
 * /api/miembros/{id}:
 *   delete:
 *     summary: Saca a alguien del comercio (HU-4)
 *     tags: [Usuarios]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Miembro quitado
 *       400:
 *         description: Intento de quitarse a uno mismo
 *       409:
 *         description: Dejaría al comercio sin propietario
 */
router.delete(
  "/:id",
  requirePermission({ member: ["delete"] }),
  controller.eliminar,
);

export default router;
