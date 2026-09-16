import { Router } from "express";
import * as controller from "../controllers/miembros.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

/**
 * @openapi
 * /api/invitaciones/{id}:
 *   get:
 *     summary: Ver una invitación antes de aceptarla (HU-4)
 *     description: >
 *       **No exige sesión a propósito**: quien recibe el link puede todavía no
 *       tener cuenta, y necesita ver a qué lo invitaron antes de crearla.
 *
 *
 *       Devuelve solo el correo invitado, el rol y el vencimiento. No expone
 *       nada del comercio: quien todavía no aceptó no tiene por qué saber
 *       quiénes son ni cómo se llama el negocio.
 *
 *
 *       Para registrarse usando la invitación se manda su `id` como
 *       `invitacionId` en el cuerpo de `/api/auth/sign-up/email`: en vez de
 *       crearle un comercio propio, se lo suma al que lo invitó.
 *     tags: [Usuarios]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Datos de la invitación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 correo: { type: string, format: email }
 *                 rol:
 *                   type: string
 *                   enum: [propietario, gerente, empleado]
 *                 venceEl: { type: string, format: date-time }
 *       404:
 *         description: La invitación no existe
 *       410:
 *         description: Venció o ya fue usada
 */
router.get("/:id", controller.verInvitacionPublica);

/**
 * @openapi
 * /api/invitaciones/{id}/aceptar:
 *   post:
 *     summary: Sumarse al comercio que invitó (HU-4)
 *     description: >
 *       Para quien ya tiene cuenta y sesión iniciada. Quien todavía no la
 *       tiene se registra mandando `invitacionId` en el alta, y queda dentro
 *       en un solo paso.
 *     tags: [Usuarios]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ya es miembro del comercio
 *       401:
 *         description: No hay sesión activa
 *       409:
 *         description: Ya es parte de ese comercio, o la invitación ya se usó
 *       410:
 *         description: Venció o ya fue usada
 */
router.post("/:id/aceptar", requireAuth, controller.aceptar);

export default router;
