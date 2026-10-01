import { Router } from "express";
import * as controller from "../controllers/movimientos.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` y el usuario
// en `req`, que es lo que hace que cada comercio mueva solo su propio stock.
router.use(requireAuth);

/**
 * @openapi
 * /api/movimientos:
 *   get:
 *     summary: Historial de movimientos de stock con filtros (HU-14)
 *     description: >
 *       Devuelve el libro de movimientos del comercio, del más nuevo al más
 *       viejo y paginado. Los filtros son opcionales y combinables entre sí.
 *
 *
 *       Cada movimiento trae todos sus datos asociados: producto (aunque esté
 *       dado de baja), ubicación y usuario que lo registró. La `cantidad` sale
 *       con signo, tal como está en el libro: entrada `+`, salida `−`.
 *
 *
 *       `desde` y `hasta` son instantes con zona, no días: el cliente resuelve
 *       dónde empieza y termina el día en la hora local del usuario y manda los
 *       límites ya calculados. Los dos son inclusivos.
 *
 *
 *       Lo pueden consultar los tres roles (`movimiento: read`).
 *     tags: [Movimientos]
 *     parameters:
 *       - in: query
 *         name: desde
 *         schema: { type: string, format: date-time, example: "2026-09-01T03:00:00.000Z" }
 *         description: Fecha y hora mínima, inclusiva. ISO 8601 con zona.
 *       - in: query
 *         name: hasta
 *         schema: { type: string, format: date-time, example: "2026-09-19T02:59:59.999Z" }
 *         description: Fecha y hora máxima, inclusiva. ISO 8601 con zona.
 *       - in: query
 *         name: productoId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: tipo
 *         schema:
 *           type: string
 *           enum: [compra, venta, ajuste, merma, transferencia]
 *       - in: query
 *         name: proveedorId
 *         schema: { type: string, format: uuid }
 *         description: >
 *           Proveedor asociado al movimiento. La tabla PROVEEDOR llega con
 *           HU-19; hasta entonces se filtra por el id guardado en el libro.
 *       - in: query
 *         name: ubicacionId
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: pagina
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limite
 *         schema: { type: integer, minimum: 1, default: 50, maximum: 200 }
 *         description: Si se pide más del máximo, se recorta a 200.
 *     responses:
 *       200:
 *         description: Página de movimientos y datos de paginación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 movimientos:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       fecha: { type: string, format: date-time }
 *                       tipo: { type: string, example: venta }
 *                       cantidad: { type: integer, example: -3 }
 *                       motivo: { type: string, nullable: true }
 *                       proveedorId: { type: string, format: uuid, nullable: true }
 *                       transferenciaId: { type: string, format: uuid, nullable: true }
 *                       producto:
 *                         type: object
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
 *                       usuario:
 *                         type: object
 *                         description: >
 *                           Quién registró el movimiento. El `correo` solo
 *                           viene para los roles que pueden ver el equipo
 *                           (`member: ["read"]`, hoy propietario y gerente):
 *                           un empleado ve el nombre de sus compañeros, no sus
 *                           correos (HU-32).
 *                         properties:
 *                           id: { type: string }
 *                           nombre: { type: string }
 *                           correo:
 *                             type: string
 *                             description: >
 *                               Solo con `member: ["read"]`.
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
 *           posterior a `hasta`, tipo desconocido, id que no es UUID, o
 *           `pagina`/`limite` que no son enteros positivos
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede consultar movimientos
 */
router.get(
  "/",
  requirePermission({ movimiento: ["read"] }),
  controller.listar,
);

/**
 * @openapi
 * /api/movimientos:
 *   post:
 *     summary: Registra un movimiento de entrada o salida de stock (HU-13, HU-15)
 *     description: >
 *       Inserta el movimiento en el libro y actualiza el stock del producto en
 *       la misma transacción, de forma atómica. La `cantidad` se envía siempre
 *       como magnitud positiva: el signo lo determina el tipo (compra suma;
 *       venta y merma restan) y, en un ajuste, el campo `sentido`.
 *
 *
 *       Si el comercio tiene una sola ubicación, `ubicacionId` puede omitirse.
 *       No se permite descontar más unidades de las disponibles.
 *
 *
 *       Los ajustes y las mermas (HU-15) exigen `motivo`: son correcciones
 *       entre el stock del sistema y el real, y sin la explicación el libro
 *       registra la diferencia pero no por qué se produjo. Quedan
 *       diferenciados de compras y ventas por el campo `tipo`.
 *     tags: [Movimientos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productoId, tipo, cantidad]
 *             properties:
 *               productoId: { type: string, format: uuid }
 *               tipo:
 *                 type: string
 *                 enum: [compra, venta, ajuste, merma]
 *                 description: >
 *                   `transferencia` no se acepta acá: esos movimientos los crea
 *                   el flujo de transferencia entre ubicaciones (HU-12), en
 *                   pares ligados.
 *               cantidad:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 2147483647
 *                 example: 3
 *                 description: >
 *                   Magnitud positiva, siempre. Tiene que ser un número JSON,
 *                   no una cadena.
 *               sentido:
 *                 type: string
 *                 enum: [entrada, salida]
 *                 description: Obligatorio solo cuando el tipo es `ajuste`.
 *               motivo:
 *                 type: string
 *                 maxLength: 255
 *                 example: Rotura de mercadería en el depósito
 *                 description: >
 *                   Por qué se hace el movimiento. **Obligatorio** cuando el
 *                   tipo es `ajuste` o `merma`, y no puede venir vacío ni en
 *                   blanco. En una compra o una venta es opcional: si no se
 *                   manda, se guarda `null`.
 *               ubicacionId:
 *                 type: string
 *                 format: uuid
 *                 description: >
 *                   Opcional si el comercio tiene una única ubicación.
 *               proveedorId:
 *                 type: string
 *                 format: uuid
 *                 description: >
 *                   Proveedor asociado, cuando corresponde (típicamente en una
 *                   compra). Todavía sin validación contra PROVEEDOR (HU-19).
 *     responses:
 *       201:
 *         description: >
 *           Movimiento registrado. Devuelve el movimiento (con la cantidad ya
 *           con signo) y el stock resultante de esa ubicación.
 *       400:
 *         description: >
 *           Datos inválidos, ajuste sin sentido, ajuste o merma sin `motivo`,
 *           `motivo` de más de 255 caracteres, o falta `ubicacionId` en un
 *           comercio con más de una ubicación
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede registrar movimientos
 *       404:
 *         description: El producto o la ubicación no existen en este comercio
 *       409:
 *         description: >
 *           El movimiento no entra contra el stock actual: o no hay unidades
 *           suficientes para descontar, o el saldo resultante superaría el
 *           máximo de 2147483647.
 */
router.post(
  "/",
  requirePermission({ movimiento: ["create"] }),
  controller.registrar,
);

export default router;
