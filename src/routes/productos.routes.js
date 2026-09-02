import { Router } from "express";
import * as controller from "../controllers/productos.controller.js";
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
 * /api/productos:
 *   get:
 *     summary: Lista los productos activos del comercio (HU-9)
 *     tags: [Productos]
 *     responses:
 *       200:
 *         description: Listado de productos, ordenados por nombre
 *       401:
 *         description: No hay sesión activa
 */
router.get("/", requirePermission({ producto: ["read"] }), controller.listar);

/**
 * @openapi
 * /api/productos/codigo/{codigoBarras}:
 *   get:
 *     summary: >
 *       Consulta un código de barras antes del alta (HU-9, opcional).
 *       Si ya existe en el comercio lo devuelve; si no, intenta sugerir
 *       nombre y categoría desde Open Food Facts para prellenar el
 *       formulario. Nunca falla por la consulta externa.
 *     tags: [Productos]
 *     parameters:
 *       - in: path
 *         name: codigoBarras
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           `{ existe: true, producto }` si ya está cargado, o
 *           `{ existe: false, sugerencia }` (sugerencia puede ser null).
 *       400:
 *         description: El código de barras tiene un formato inválido
 */
router.get(
  "/codigo/:codigoBarras",
  requirePermission({ producto: ["create"] }),
  controller.verificarCodigo,
);

/**
 * @openapi
 * /api/productos/{id}:
 *   get:
 *     summary: Obtiene un producto del comercio por id, con su stock (HU-9/HU-11)
 *     description: >
 *       Además de los datos del producto, incluye `stock`: el saldo
 *       discriminado por cada ubicación del comercio (con 0 en las que
 *       todavía no tienen movimientos) y el total, que es la suma de esas
 *       filas.
 *     tags: [Productos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: El producto, con su stock por ubicación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 nombre: { type: string }
 *                 codigoBarras: { type: string }
 *                 categoria: { type: string }
 *                 unidadMedida: { type: string }
 *                 umbralMinimo: { type: integer }
 *                 stock:
 *                   type: object
 *                   properties:
 *                     porUbicacion:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           ubicacionId: { type: string, format: uuid }
 *                           ubicacionNombre: { type: string, example: Depósito }
 *                           cantidad: { type: integer, example: 12 }
 *                     total: { type: integer, example: 12 }
 *       404:
 *         description: El producto no existe en este comercio
 */
router.get(
  "/:id",
  requirePermission({ producto: ["read"] }),
  controller.obtener,
);

/**
 * @openapi
 * /api/productos:
 *   post:
 *     summary: Da de alta un producto y su stock inicial (HU-9)
 *     description: >
 *       Crea el producto y, en la misma transacción, la fila de `stock`
 *       inicial. Si no se indica `ubicacionId`, usa la primera ubicación del
 *       comercio o crea una "Principal" si todavía no tiene ninguna.
 *     tags: [Productos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre, codigoBarras, categoria, unidadMedida, umbralMinimo, stockActual]
 *             properties:
 *               nombre: { type: string, example: Coca-Cola 500ml }
 *               codigoBarras: { type: string, example: "7790895000782" }
 *               categoria: { type: string, example: Bebidas }
 *               unidadMedida: { type: string, example: unidad }
 *               umbralMinimo: { type: integer, example: 5 }
 *               stockActual: { type: integer, example: 20 }
 *               ubicacionId: { type: string, format: uuid }
 *     responses:
 *       201:
 *         description: Producto creado, con su stock inicial
 *       400:
 *         description: Datos incompletos o inválidos
 *       403:
 *         description: El rol no puede crear productos
 *       409:
 *         description: Ya existe un producto con ese código de barras en el comercio
 */
router.post(
  "/",
  requirePermission({ producto: ["create"] }),
  controller.crear,
);

/**
 * @openapi
 * /api/productos/{id}:
 *   put:
 *     summary: Edita un producto existente (HU-9)
 *     description: >
 *       Acepta un subconjunto de campos. No modifica el stock: cambiar
 *       cantidades es responsabilidad del registro de movimientos (HU-13).
 *     tags: [Productos]
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
 *               codigoBarras: { type: string }
 *               categoria: { type: string }
 *               unidadMedida: { type: string }
 *               umbralMinimo: { type: integer }
 *     responses:
 *       200:
 *         description: Producto actualizado
 *       400:
 *         description: Datos inválidos
 *       404:
 *         description: El producto no existe en este comercio
 *       409:
 *         description: El nuevo código de barras ya lo usa otro producto del comercio
 */
router.put(
  "/:id",
  requirePermission({ producto: ["update"] }),
  controller.actualizar,
);

/**
 * @openapi
 * /api/productos/{id}:
 *   delete:
 *     summary: Elimina (lógicamente) un producto (HU-9)
 *     description: >
 *       Marca el producto como inactivo. Es idempotente: repetir el borrado,
 *       o llamarlo sobre un id que no es de este comercio, siempre devuelve
 *       204 sin error.
 *     tags: [Productos]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Producto eliminado (o ya no existía)
 *       403:
 *         description: El rol no puede eliminar productos
 */
router.delete(
  "/:id",
  requirePermission({ producto: ["delete"] }),
  controller.eliminar,
);

export default router;