import { Router } from "express";
import * as controller from "../controllers/datosPersonales.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

/**
 * `requireAuth` va ruta por ruta, no con un `router.use`.
 *
 * Este router se monta en `/api` a secas, porque sus rutas son `/mis-datos` y
 * `/mi-cuenta`: son de la persona, no de un recurso del comercio. Con un
 * `router.use(requireAuth)` ese middleware correria en CUALQUIER pedido a
 * `/api/*`, aunque despues no matchee ninguna ruta de acá, y como responde 401
 * en vez de seguir la cadena, se comeria los endpoints publicos de los demas.
 * Ya paso: dejo en 401 el `GET /api/invitaciones/:id` de HU-4, que a proposito
 * se puede ver sin sesion para decidir antes de crear la cuenta.
 *
 * Sin `requirePermission`: estos endpoints no dependen del rol. Cualquiera
 * tiene derecho sobre sus propios datos, incluido un empleado.
 */

/**
 * @openapi
 * /api/mis-datos:
 *   get:
 *     summary: Descargar los datos personales propios (HU-31)
 *     description: >
 *       Derecho de acceso de la Ley 25.326: devuelve todo lo que el sistema
 *       guarda de quien lo pide, como archivo descargable.
 *
 *
 *       Incluye los datos de la cuenta, en qué comercios participa, sus
 *       sesiones activas y su actividad registrada — todo eso es dato
 *       personal, porque saber que alguien entró a tal hora también dice algo
 *       de esa persona.
 *
 *
 *       **No incluye la contraseña**, ni siquiera hasheada: el hash es
 *       justamente lo que nunca debe salir del sistema.
 *     tags: [Datos personales]
 *     responses:
 *       200:
 *         description: Los datos personales, como descarga JSON
 *       401:
 *         description: No hay sesión activa
 */
router.get("/mis-datos", requireAuth, controller.misDatos);

/**
 * @openapi
 * /api/mi-cuenta:
 *   delete:
 *     summary: Dar de baja la propia cuenta (HU-31)
 *     description: >
 *       Derecho de supresión de la Ley 25.326.
 *
 *
 *       **Anonimiza en vez de borrar la fila, y es a propósito.**
 *       `movimiento.usuario_id` es `NOT NULL` con `ON DELETE RESTRICT`, porque
 *       el libro de movimientos es append-only y tiene que saber quién
 *       registró cada uno: un DELETE fallaría para casi cualquier usuario.
 *       Anonimizar resuelve la tensión — se eliminan los datos que identifican
 *       a la persona y la fila queda para que el libro conserve su integridad.
 *       Un registro que ya no identifica a nadie deja de ser dato personal.
 *
 *
 *       Lo que sí se borra de verdad: el hash de la contraseña, los tokens y
 *       las sesiones. Después de esto no se puede volver a entrar.
 *
 *
 *       Se rechaza si quien pide la baja es el único propietario de algún
 *       comercio: ese comercio quedaría sin nadie que pueda administrarlo.
 *     tags: [Datos personales]
 *     responses:
 *       204:
 *         description: Cuenta dada de baja
 *       401:
 *         description: No hay sesión activa
 *       409:
 *         description: Es el único propietario de un comercio
 */
router.delete("/mi-cuenta", requireAuth, controller.darDeBaja);

export default router;
