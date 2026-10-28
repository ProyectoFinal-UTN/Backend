import { Router } from "express";
import * as controller from "../controllers/proveedores.controller.js";
import * as compras from "../controllers/comprasProveedor.controller.js";
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
 * /api/proveedores/{id}/historial-compras:
 *   get:
 *     summary: Historial de compras hechas a un proveedor (HU-21)
 *     description: >
 *       Se construye a partir del libro de movimientos: las filas de tipo
 *       `compra` que apuntan a este proveedor, de la más nueva a la más vieja,
 *       con filtro por período y paginación.
 *
 *
 *       El tipo es fijo y no se puede cambiar: un ajuste positivo o la pata de
 *       destino de una transferencia también son entradas de stock, pero no son
 *       compras a un proveedor. Para filtrar el libro por cualquier otro
 *       criterio está `GET /api/movimientos` (HU-14).
 *
 *
 *       Las compras **sin** proveedor no aparecen en ningún historial:
 *       `proveedor_id` es opcional en el registro de movimientos (HU-13), y una
 *       compra que no dice a quién se le compró no se le puede atribuir a
 *       nadie.
 *
 *
 *       Incluye a los proveedores dados de baja: el historial tiene que seguir
 *       mostrando a quién se le compró aunque hoy ya no se le compre más. El
 *       bloque `proveedor` trae `activo` para poder etiquetarlo.
 *
 *
 *       **El historial no informa montos.** El libro de movimientos (HU-13) no
 *       guarda precio ni costo, y no hay ningún campo monetario en las tablas
 *       relacionadas, así que no hay de dónde calcularlos. `resumen.montos`
 *       viene explícitamente en `null`, y el resumen informa el volumen
 *       (compras, unidades, primera y última) en su lugar.
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: desde
 *         schema: { type: string, format: date-time }
 *         example: "2026-01-01T03:00:00.000Z"
 *         description: >
 *           Límite inferior del período, inclusive. Fecha y hora ISO 8601 con
 *           zona explícita (`Z` u offset): dónde empieza "su" día lo sabe el
 *           cliente, no el servidor. Se puede omitir para no acotar por abajo.
 *       - in: query
 *         name: hasta
 *         schema: { type: string, format: date-time }
 *         example: "2026-12-31T02:59:59.999Z"
 *         description: Límite superior del período, inclusive. Mismo formato que `desde`.
 *       - in: query
 *         name: pagina
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limite
 *         schema: { type: integer, minimum: 1, default: 50, maximum: 200 }
 *         description: Si se pide más del máximo, se recorta a 200.
 *     responses:
 *       200:
 *         description: Página de compras, el resumen del período y la paginación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 proveedor:
 *                   type: object
 *                   description: >
 *                     Para titular la pantalla sin otra consulta. Hace falta
 *                     acá porque `GET /api/proveedores/{id}` no devuelve a los
 *                     dados de baja, que este historial sí muestra.
 *                   properties:
 *                     id: { type: string, format: uuid }
 *                     nombre: { type: string, example: Distribuidora Sur }
 *                     activo: { type: boolean }
 *                 compras:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       fecha: { type: string, format: date-time, example: "2026-10-12T14:03:00.000Z" }
 *                       cantidad: { type: integer, example: 24, description: Unidades compradas, siempre positiva }
 *                       motivo: { type: string, nullable: true }
 *                       producto:
 *                         type: object
 *                         description: >
 *                           Sale aunque el producto esté dado de baja
 *                           (`activo: false`): se le compró igual.
 *                         properties:
 *                           id: { type: string, format: uuid }
 *                           nombre: { type: string }
 *                           codigoBarras: { type: string }
 *                           unidadMedida: { type: string }
 *                           activo: { type: boolean }
 *                       ubicacion:
 *                         type: object
 *                         properties:
 *                           id: { type: string, format: uuid }
 *                           nombre: { type: string }
 *                 resumen:
 *                   type: object
 *                   description: >
 *                     Calculado sobre todo el período filtrado, no sobre la
 *                     página: no cambia al pasar de página.
 *                   properties:
 *                     compras: { type: integer, example: 37, description: Cuántas compras hay en el período }
 *                     unidades: { type: integer, example: 912, description: Suma de las cantidades compradas }
 *                     primeraCompra: { type: string, format: date-time, nullable: true }
 *                     ultimaCompra: { type: string, format: date-time, nullable: true }
 *                     montos:
 *                       type: object
 *                       nullable: true
 *                       description: >
 *                         Siempre `null`. El modelo de movimientos no guarda
 *                         precio ni costo, así que no hay montos para informar.
 *                 paginacion:
 *                   type: object
 *                   properties:
 *                     pagina: { type: integer }
 *                     limite: { type: integer }
 *                     total: { type: integer }
 *                     totalPaginas: { type: integer }
 *       400:
 *         description: >
 *           Algún filtro es inválido: fecha sin formato ISO con zona, `desde`
 *           posterior a `hasta`, o `pagina`/`limite` que no son enteros
 *           positivos
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede consultar movimientos
 *       404:
 *         description: >
 *           El proveedor no existe en este comercio. Mismo mensaje que cuando
 *           el id no existe en ninguno: decir "existe pero no es tuyo"
 *           filtraría información de otro comercio
 */
router.get(
  "/:id/historial-compras",
  // El permiso acompaña al dato que se devuelve y no al prefijo de la URL,
  // igual que `GET /api/productos/{id}/proveedores` (HU-20) pide
  // `proveedor: ["read"]`: lo que se lee acá es el libro de movimientos.
  requirePermission({ movimiento: ["read"] }),
  compras.listarHistorial,
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
