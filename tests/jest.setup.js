/**
 * Candado: ningun test puede hablarle al proveedor de LLM.
 *
 * Es una regla del equipo —el credito del AI Gateway es UNO SOLO para los tres
 * integrantes— y hasta ahora se cumplia de casualidad, no por diseño: se
 * cumplia si el `.env` de quien corria la suite tenia la key vacia. Con la key
 * puesta, que es como trabaja cualquiera que este tocando E5, `npm test`
 * gastaba credito de verdad.
 *
 * El agujero concreto: `src/app.js` importa `dotenv/config` en su primera
 * linea, asi que todo test de integracion carga el `.env` real, key incluida.
 * Lo detecto HU-27: `tests/controlAcceso.test.js` pega a
 * `GET /api/asistente/recomendaciones`, el comercio del escenario no tiene
 * ventas, eso devuelve una recomendacion (`sin_historial`) y no una lista
 * vacia, y con una recomendacion el service si le pide el resumen al modelo.
 *
 * Se asignan en vacio y no se borran con `delete`: `dotenv` no pisa lo que ya
 * existe en `process.env`, pero si completa lo que falta. Borrarlas aca las
 * dejaria disponibles para que `dotenv` las volviera a poner en el momento en
 * que el test importa la app, que es exactamente el caso que esto evita.
 * Definidas en vacio, `hayProveedorConfigurado()` da `false` y el asistente
 * contesta por reglas (HU-28) en toda la suite.
 *
 * Un test que necesite probar el camino con proveedor mockea `src/lib/llm.js`,
 * que es el patron de `tests/asistente.service.test.js` y
 * `tests/asistente.recomendaciones.test.js`.
 */
process.env.LLM_API_KEY = "";
process.env.AI_GATEWAY_API_KEY = "";
