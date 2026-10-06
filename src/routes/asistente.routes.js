import { Router } from "express";
import * as controller from "../controllers/asistente.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` en `req`, que
// es lo único sobre lo que el asistente puede consultar.
router.use(requireAuth);

/**
 * @openapi
 * /api/asistente/consultas:
 *   post:
 *     summary: Consulta en lenguaje natural sobre los datos del comercio (HU-26)
 *     description: >
 *       Recibe una pregunta escrita como la diría un comerciante ("¿qué tengo
 *       que reponer?", "¿cuánta harina me queda?") y devuelve la respuesta en
 *       texto.
 *
 *
 *       El modelo de lenguaje **no calcula los números**: elige cuál de las
 *       consultas disponibles correr y con qué argumentos, y el sistema las
 *       resuelve en SQL. Las consultas filtran siempre por el comercio de la
 *       sesión, que el modelo no puede ver ni elegir.
 *
 *
 *       Si el proveedor del modelo falla o tarda más de 4 segundos, la
 *       respuesta se arma por reglas (HU-28) y sale con `modo` en `limitado`.
 *       Eso **no** es un error: el status sigue siendo 200 y la pantalla avisa
 *       que la respuesta es limitada. Un 5xx acá significa otra cosa.
 *
 *
 *       Todavía no puede responder sobre proveedores ni precios: la tabla
 *       PROVEEDOR llega con HU-19.
 *     tags: [Asistente]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pregunta]
 *             properties:
 *               pregunta:
 *                 type: string
 *                 maxLength: 500
 *                 example: ¿Qué productos tengo que reponer?
 *     responses:
 *       200:
 *         description: La respuesta del asistente.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 respuesta:
 *                   type: string
 *                   # Entre comillas por el ": " de "reponer: harina": en YAML
 *                   # eso abre un mapa anidado y rompe el bloque. Sin ellas,
 *                   # swagger-jsdoc descarta TODO este archivo y ninguna ruta
 *                   # del asistente llega a /api-docs.
 *                   example: "Tenés tres productos para reponer: harina 000 (te quedan 2 kg, el mínimo es 10), yerba (0 de 5) y azúcar (1 de 6)."
 *                 modo:
 *                   type: string
 *                   enum: [ia, limitado]
 *                   description: >
 *                     `ia` si la armó el modelo con los datos del comercio.
 *                     `limitado` si el proveedor no estaba disponible y se
 *                     respondió por reglas (HU-28).
 *                 herramientasUsadas:
 *                   type: array
 *                   description: Qué consultas se corrieron para armar la respuesta. Vacío en modo limitado.
 *                   items:
 *                     type: string
 *                   example: [productosParaReponer]
 *       400:
 *         description: La pregunta está vacía o supera los 500 caracteres.
 *       401:
 *         description: No hay sesión activa.
 *       403:
 *         description: El rol no tiene permiso para usar el asistente.
 */
router.post(
  "/consultas",
  requirePermission({ asistente: ["consultar"] }),
  controller.consultar,
);

/**
 * @openapi
 * /api/asistente/recomendaciones:
 *   get:
 *     summary: Recomendaciones proactivas sobre la gestión del comercio (HU-27)
 *     description: >
 *       Devuelve sugerencias que el sistema arma mirando los datos del
 *       comercio, sin que nadie pregunte nada. A diferencia de
 *       `/consultas`, acá no hay pregunta: es el asistente el que propone.
 *
 *
 *       Hay tres tipos de recomendación:
 *
 *
 *       * `reponer` — productos que llegaron al umbral mínimo o lo
 *         perforaron. Prioridad `alta` si no queda nada, `media` si está en
 *         el mínimo.
 *
 *       * `baja_rotacion` — productos **con existencias** que no registraron
 *         ninguna venta en la ventana analizada (30 días por defecto). Se
 *         excluyen los que se dieron de alta dentro de la ventana: un
 *         producto nuevo no tiene poca rotación, tiene poca historia.
 *
 *       * `sin_historial` — aparece **en lugar** de las de baja rotación
 *         cuando el comercio registró menos ventas que el mínimo necesario
 *         para comparar. Es el estado esperable en un comercio nuevo, y no
 *         es un error: sin ventas cargadas, "ningún producto se vende" sería
 *         verdad literal y mentira práctica.
 *
 *
 *       El `texto` y el `porQue` de cada recomendación los arma el sistema
 *       con plantillas, así que **no dependen del modelo de lenguaje**. El
 *       LLM solo redacta el `resumen` de arriba. Si el proveedor falla o
 *       tarda más de 4 segundos, el `resumen` sale por plantilla y `modo`
 *       viene en `limitado` (HU-28), pero las recomendaciones llegan
 *       completas igual. Eso **no** es un error: el status sigue siendo 200.
 *
 *
 *       Cuando no hay nada para recomendar la respuesta es 200 con
 *       `recomendaciones` en `[]` y un `resumen` que lo explica — nunca un
 *       404 ni un error. En ese caso tampoco se consulta al modelo.
 *
 *
 *       Las cifras las calcula Postgres y filtran siempre por el comercio de
 *       la sesión. El modelo no ve el comercio ni los ids.
 *     tags: [Asistente]
 *     parameters:
 *       - in: query
 *         name: dias
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 90
 *           default: 30
 *         description: >
 *           Ventana de análisis, en días. Un valor fuera de rango o no
 *           numérico se acota en silencio en vez de dar 400: es un parámetro
 *           de afinado, no un dato del usuario. El default se puede cambiar
 *           con `RECOMENDACIONES_DIAS` en el `.env`.
 *     responses:
 *       200:
 *         description: Las recomendaciones del comercio. Puede venir vacía.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 generadoEn:
 *                   type: string
 *                   format: date-time
 *                   description: Cuándo se calculó. El análisis es al vuelo, no precalculado.
 *                 ventana:
 *                   type: object
 *                   properties:
 *                     dias:
 *                       type: integer
 *                       example: 30
 *                     desde:
 *                       type: string
 *                       format: date-time
 *                 modo:
 *                   type: string
 *                   enum: [ia, limitado]
 *                   description: >
 *                     De dónde salió el `resumen`, y nada más: `ia` si lo
 *                     redactó el modelo, `limitado` si salió de plantilla. Las
 *                     `recomendaciones` son exactamente las mismas en los dos
 *                     casos — lo único que cambia es el párrafo de arriba.
 *
 *
 *                     **Atención al mostrarlo:** con `recomendaciones` vacía el
 *                     `modo` es siempre `limitado`, porque no se le pide un
 *                     resumen al modelo cuando no hay nada que resumir. Eso
 *                     **no** es una degradación del servicio y no corresponde
 *                     mostrar el aviso de "respuesta limitada" que sí
 *                     corresponde en `/consultas`. Para decidir si avisar,
 *                     mirar `modo` **junto con** `recomendaciones.length`.
 *                 resumen:
 *                   type: string
 *                   description: Párrafo de presentación. Nunca viene vacío ni nulo.
 *                   example: Mirando tu negocio encontré 1 producto para reponer y 2 productos que no se están vendiendo. Abajo te digo qué haría con cada uno.
 *                 recomendaciones:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       tipo:
 *                         type: string
 *                         enum: [reponer, baja_rotacion, sin_historial]
 *                       prioridad:
 *                         type: string
 *                         enum: [alta, media, baja]
 *                       producto:
 *                         type: object
 *                         nullable: true
 *                         description: El producto afectado, o `null` cuando la recomendación es del comercio entero (`sin_historial`).
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           nombre:
 *                             type: string
 *                       texto:
 *                         type: string
 *                         description: La sugerencia redactada sin jerga técnica, para mostrar tal cual.
 *                         example: Hace 30 días que no vendés Yerba Playadito y te quedan 12 unidades. Podés probar con una promoción o no reponer por ahora.
 *                       porQue:
 *                         type: string
 *                         description: Por qué se generó, en una línea.
 *                         example: No tuvo ninguna venta entre el 06/09 y el 06/10, y quedan 12 unidades en stock.
 *                       datos:
 *                         type: object
 *                         description: Las cifras que sostienen la recomendación, para que la pantalla ordene y destaque sin recalcular nada.
 *       401:
 *         description: No hay sesión activa.
 *       403:
 *         description: El rol no tiene permiso para ver las recomendaciones (el empleado no lo tiene).
 */
router.get(
  "/recomendaciones",
  requirePermission({ asistente: ["recomendaciones"] }),
  controller.recomendaciones,
);

export default router;
