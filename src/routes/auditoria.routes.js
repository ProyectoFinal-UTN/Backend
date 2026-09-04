import { Router } from "express";
import * as controller from "../controllers/auditoria.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /api/auditoria:
 *   get:
 *     summary: Registro de accesos y acciones (HU-5)
 *     description: >
 *       Devuelve los hechos del comercio, del más nuevo al más viejo, con
 *       fecha, hora, usuario y tipo de acción.
 *
 *
 *       **Solo lo ve el propietario.** Es un criterio de aceptación explícito,
 *       y se hace cumplir con `requirePermission({ auditoria: ["read"] })`: en
 *       la matriz de permisos, `auditoria` está vacío para gerente y empleado.
 *
 *
 *       El registro es de solo lectura: no hay endpoint para editar ni borrar
 *       un evento. Una auditoría que se puede modificar no sirve para nada.
 *     tags: [Auditoría]
 *     parameters:
 *       - in: query
 *         name: accion
 *         schema: { type: string, example: eliminar }
 *         description: Filtra por tipo de acción.
 *       - in: query
 *         name: recurso
 *         schema: { type: string, example: producto }
 *         description: Filtra por qué se tocó.
 *       - in: query
 *         name: limite
 *         schema: { type: integer, default: 100, maximum: 500 }
 *     responses:
 *       200:
 *         description: Eventos y las opciones disponibles para filtrar
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 eventos:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       usuarioCorreo: { type: string, nullable: true }
 *                       accion: { type: string, example: crear }
 *                       recurso: { type: string, example: producto }
 *                       recursoId: { type: string, nullable: true }
 *                       detalle: { type: string, nullable: true }
 *                       ip: { type: string, nullable: true }
 *                       fecha: { type: string, format: date-time }
 *                 filtros:
 *                   type: object
 *                   properties:
 *                     acciones: { type: array, items: { type: string } }
 *                     recursos: { type: array, items: { type: string } }
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: Solo el propietario accede a la auditoría
 */
router.get("/", requirePermission({ auditoria: ["read"] }), controller.listar);

export default router;
