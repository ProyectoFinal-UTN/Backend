import { Router } from "express";
import * as controller from "../controllers/proveedores.controller.js";
import * as vinculos from "../controllers/productoProveedor.controller.js";
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
 * components:
 *   schemas:
 *     Proveedor:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         nombre: { type: string, example: Distribuidora Sur }
 *         contacto: { type: string, nullable: true, example: Laura Gómez }
 *         telefono: { type: string, nullable: true, example: "11 5555-0000" }
 *         correo: { type: string, nullable: true, example: ventas@distrisur.com }
 *         rubro: { type: string, nullable: true, example: Bebidas }
 *         condicionesPago: { type: string, nullable: true, example: 30 días }
 *         createdAt: { type: string, format: date-time }
 *         updatedAt: { type: string, format: date-time }
 */

/**
 * @openapi
 * /api/proveedores:
 *   get:
 *     summary: Lista los proveedores activos del comercio (HU-19)
 *     tags: [Proveedores]
 *     responses:
 *       200:
 *         description: Listado de proveedores, ordenados por nombre
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: "#/components/schemas/Proveedor" }
 *       401:
 *         description: No hay sesión activa
 */
router.get("/", requirePermission({ proveedor: ["read"] }), controller.listar);

/**
 * @openapi
 * /api/proveedores/{id}:
 *   get:
 *     summary: Obtiene un proveedor del comercio por id (HU-19)
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: El proveedor
 *         content:
 *           application/json:
 *             schema: { $ref: "#/components/schemas/Proveedor" }
 *       404:
 *         description: El proveedor no existe en este comercio
 */
router.get(
  "/:id",
  requirePermission({ proveedor: ["read"] }),
  controller.obtener,
);

/**
 * @openapi
 * /api/proveedores/{id}/productos:
 *   get:
 *     summary: Productos asociados a un proveedor (HU-20)
 *     description: >
 *       Solo los activos, ordenados por nombre. Para asociar o quitar se usa
 *       `/api/productos/{id}/proveedores`: el vínculo es uno solo y se escribe
 *       por un único lado.
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Los productos del proveedor (puede ser una lista vacía)
 *       404:
 *         description: El proveedor no existe en este comercio
 */
router.get(
  "/:id/productos",
  requirePermission({ proveedor: ["read"] }),
  vinculos.listarProductosDeProveedor,
);

/**
 * @openapi
 * /api/proveedores:
 *   post:
 *     summary: Da de alta un proveedor (HU-19)
 *     description: >
 *       Solo el nombre es obligatorio, y no puede repetirse entre los
 *       proveedores activos del comercio (sin distinguir mayúsculas). Los
 *       demás campos son opcionales; vacíos se guardan como null.
 *     tags: [Proveedores]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, maxLength: 150, example: Distribuidora Sur }
 *               contacto: { type: string, maxLength: 150, example: Laura Gómez }
 *               telefono: { type: string, maxLength: 40, example: "11 5555-0000" }
 *               correo: { type: string, maxLength: 255, example: ventas@distrisur.com }
 *               rubro: { type: string, maxLength: 100, example: Bebidas }
 *               condicionesPago: { type: string, maxLength: 255, example: 30 días }
 *     responses:
 *       201:
 *         description: Proveedor creado
 *         content:
 *           application/json:
 *             schema: { $ref: "#/components/schemas/Proveedor" }
 *       400:
 *         description: Datos incompletos o inválidos
 *       403:
 *         description: El rol no puede crear proveedores
 *       409:
 *         description: Ya existe un proveedor con ese nombre en el comercio
 */
router.post(
  "/",
  requirePermission({ proveedor: ["create"] }),
  controller.crear,
);

/**
 * @openapi
 * /api/proveedores/{id}:
 *   put:
 *     summary: Edita un proveedor existente (HU-19)
 *     description: >
 *       Acepta un subconjunto de campos. Mandar null o "" en un campo
 *       opcional lo borra; el nombre no se puede vaciar.
 *     tags: [Proveedores]
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
 *             properties:
 *               nombre: { type: string }
 *               contacto: { type: string, nullable: true }
 *               telefono: { type: string, nullable: true }
 *               correo: { type: string, nullable: true }
 *               rubro: { type: string, nullable: true }
 *               condicionesPago: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Proveedor actualizado
 *         content:
 *           application/json:
 *             schema: { $ref: "#/components/schemas/Proveedor" }
 *       400:
 *         description: Datos inválidos
 *       403:
 *         description: El rol no puede editar proveedores
 *       404:
 *         description: El proveedor no existe en este comercio
 *       409:
 *         description: El nuevo nombre ya lo usa otro proveedor del comercio
 */
router.put(
  "/:id",
  requirePermission({ proveedor: ["update"] }),
  controller.actualizar,
);

/**
 * @openapi
 * /api/proveedores/{id}:
 *   delete:
 *     summary: Elimina (lógicamente) un proveedor (HU-19)
 *     description: >
 *       Lo marca como inactivo: deja de aparecer en el listado y no se le
 *       pueden registrar compras nuevas, pero las compras ya registradas lo
 *       siguen referenciando en el historial. Es idempotente: repetir el
 *       borrado, o llamarlo sobre un id que no es de este comercio, siempre
 *       devuelve 204 sin error.
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Proveedor eliminado (o ya no existía)
 *       403:
 *         description: El rol no puede eliminar proveedores
 */
router.delete(
  "/:id",
  requirePermission({ proveedor: ["delete"] }),
  controller.eliminar,
);

export default router;
