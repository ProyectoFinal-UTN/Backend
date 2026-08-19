# Backend — convenciones

Stack: Node + Express 5 + Drizzle ORM + PostgreSQL en Neon + Swagger. Auth vía Better Auth (rol y sesión).

## Regla de tres capas — innegociable

```
routes → controller → service → db
```

- `routes/`: define endpoint (URL + método) y la documentación `@openapi`. No tiene lógica.
- `controllers/`: recibe `req`/`res`, llama al `service`, devuelve la respuesta HTTP. No habla con la base directamente.
- `services/`: la lógica de negocio real. **Es la única capa que toca la base** (vía `db/client.js` y Drizzle).
- `db/schema.js`: definición de tablas. `db/client.js`: conexión a Postgres.

Una ruta que llama directo a `db` sin pasar por `service`, o un controller con lógica de negocio adentro, rompe el patrón y complica el review — no lo hagas aunque "sea más rápido para esta HU".

## Agregar un módulo nuevo (una Épica nueva)

Mismo patrón que ya está armado para `usuarios`:

1. `src/routes/<modulo>.routes.js` — define el router.
2. `src/controllers/<modulo>.controller.js` y `src/services/<modulo>.service.js`.
3. Montar en `src/index.js`:
   ```js
   import productosRoutes from "./routes/productos.routes.js";
   app.use("/api/productos", productosRoutes);
   ```
4. Documentar cada endpoint con comentarios `@openapi` arriba de la ruta — Swagger escanea `src/index.js` y `src/routes/*.js` automáticamente, no hace falta configurar nada más.

## Auth y roles

- `src/middlewares/auth.middleware.js` (`requireAuth`) es donde vive la validación de sesión vía Better Auth.
- Los tres roles son exactamente `propietario`, `gerente`, `empleado` (RF9).
- **Cualquier ruta que deba restringirse por rol usa un middleware de verificación — nunca se valida el rol a mano dentro de un controller.** Si una HU necesita una restricción de rol que el middleware actual no cubre, se extiende el middleware, no se agrega un `if` suelto en el controller.
- Todo lo que lea o escriba una tabla de negocio filtra por `comercio_id` tomado de la sesión (ver `references/data-model.md`).

## Base de datos (Drizzle)

Cada vez que se modifica `src/db/schema.js`:

```bash
npx drizzle-kit generate   # genera el .sql de migración en /drizzle
npx drizzle-kit migrate    # aplica contra la base real (Neon)
```

Para inspeccionar la base: `npx drizzle-kit studio`.

Operaciones que mueven stock (ver `references/data-model.md`) van dentro de una transacción de Drizzle — nunca dos escrituras sueltas.

## Variables de entorno y secretos

- `.env` real: nunca se commitea, nunca se comparte por chat grupal. Se pide 1 a 1 o por gestor de contraseñas.
- `.env.example` sí se commitea, solo con nombres de variable y placeholders.
- Si `process.env.DATABASE_URL` da `undefined` en `drizzle.config.js`: falta `import "dotenv/config";` al principio del archivo.

## Desarrollo del día a día

```bash
npm run dev   # nodemon, recarga sola. API en :4000, Swagger en /api-docs, health en /health
```

Docker en este repo **no es para el día a día** — es para orquestar junto a Frontend + Nginx desde `Infraestructura`, simulando integración local. Producción es Render, sin Nginx propio.

## Troubleshooting conocido

- Warning de SSL en `drizzle-kit migrate` ("SECURITY WARNING: The SSL modes..."): esperado por `sslmode=require` de Neon, no es error.
- Swagger dice "No operations defined in spec!": el archivo con `@openapi` no está en el array `apis` de la config de `src/index.js`.
