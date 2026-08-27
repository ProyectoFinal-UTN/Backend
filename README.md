# Backend — Centralización y Optimización de la Gestión Comercial

API REST del proyecto. Node + Express + Drizzle ORM + PostgreSQL (Neon), con documentación Swagger.

## Stack

- **Node.js** (versión fijada en `.nvmrc`)
- **Express 5**
- **Drizzle ORM** + `pg` (driver de PostgreSQL)
- **Swagger** (`swagger-jsdoc` + `swagger-ui-express`) — documentación interactiva
- **Better Auth** (+ plugin `organization`) — sesión, roles y multi-tenant
- **Jest** + **supertest** — tests unitarios y de integración
- **ESLint** — linter
- Base de datos: **PostgreSQL en Neon**

## Requisitos previos

- Node.js en la versión indicada en `.nvmrc` (usar `nvm use` si tenés nvm instalado)
- Acceso al `DATABASE_URL` de Neon (pedirlo a quien administre el proyecto — **nunca se comparte por chat grupal**, ver sección de secretos más abajo)

## Instalación

```bash
git clone git@github.com:ProyectoFinal-UTN/Backend.git
cd Backend
npm install
```

## Variables de entorno

1. Copiar `.env.example` como `.env`:

```bash
cp .env.example .env
```

2. Completar `.env` con los valores reales (pedirlos al equipo, nunca inventarlos ni dejarlos con el placeholder de ejemplo).
3. **El archivo `.env` NUNCA se commitea.** Ya está en `.gitignore`, pero prestá atención antes de cualquier `git add .` si alguna vez lo movés o renombrás.

`BETTER_AUTH_SECRET` es la única que no se pide al equipo: cada uno genera la suya en local con

```bash
openssl rand -base64 32
```

En producción (Render) se carga una distinta, en las variables de entorno del servicio.

## Levantar el proyecto en desarrollo

```bash
npm run dev
```

Esto levanta el servidor con `nodemon` (reinicia solo ante cada cambio). Por defecto:

- API disponible en `http://localhost:4000`
- Documentación Swagger en `http://localhost:4000/api-docs`
- Endpoint de salud: `GET /health`

## Docker

Este repo incluye un `Dockerfile` que empaqueta el backend como contenedor. **No se usa de forma aislada** — está pensado para ser construido y orquestado en conjunto con `Frontend` y `Nginx` desde el repo `Infraestructura`, que tiene su propio `docker-compose.yml` referenciando este repo como contexto de build.

Para desarrollo del día a día, seguir usando `npm run dev` como se indica arriba — Docker es la forma de levantar el stack completo (frontend + backend + Nginx) en un entorno local que simula la integración entre servicios, útil para pruebas y para demostrar la arquitectura, pero **no es lo que corre en producción**. El backend se despliega en producción como servicio independiente en **Render**, sin Nginx propio (ver Informe de Arquitectura y Despliegue).

Si se necesita construir la imagen de este repo de forma aislada (poco común, mayormente para debug):

```bash
docker build -t backend .
```

## Base de datos (Drizzle)

El schema de las tablas vive en `src/db/schema.js`. Cada vez que se modifica ese archivo:

```bash
npx drizzle-kit generate   # genera el archivo .sql de migración en /drizzle
npx drizzle-kit migrate    # aplica la migración contra la base real (Neon)
```

Para inspeccionar la base visualmente:

```bash
npx drizzle-kit studio
```

## Estructura de carpetas

```
src/
├── index.js               # solo levanta el servidor (app.listen)
├── app.js                 # arma Express: CORS, Better Auth, Swagger, rutas, errores
├── lib/
│   ├── auth.js            # configuración de Better Auth
│   └── permissions.js     # roles de RF9 y matriz de permisos
├── db/
│   ├── client.js          # conexión a Postgres (Drizzle)
│   └── schema.js          # definición de tablas
├── routes/                # define endpoints (URL + método), documentación Swagger
├── controllers/           # recibe req/res, llama al service, devuelve la respuesta HTTP
├── services/              # lógica de negocio real, es lo único que habla con la base
└── middlewares/           # funciones que corren antes del controller (auth, roles, errores)

tests/                     # Jest: unitarios y de integración (supertest)
drizzle/                   # migraciones generadas, no se editan a mano
```

`index.js` y `app.js` están separados a propósito: los tests de integración importan `app` sin abrir un puerto.

**Regla de tres capas**: una ruta nunca llama directo a la base. El flujo siempre es:

```
routes → controller → service → db
```

## Cómo agregar un módulo nuevo (una Épica nueva)

Seguir el mismo patrón que ya está armado para `usuarios`. Por ejemplo, para arrancar el módulo de **productos**:

1. Crear `src/routes/productos.routes.js`:

```js
import { Router } from "express";
const router = Router();
// rutas acá
export default router;
```

2. Crear `src/controllers/productos.controller.js` y `src/services/productos.service.js` siguiendo el mismo esquema que `usuarios.*`.
3. Montar la ruta en `src/index.js`:

```js
import productosRoutes from "./routes/productos.routes.js";
app.use("/api/productos", productosRoutes);
```

4. Documentar cada endpoint con comentarios `@openapi` arriba de la ruta (ya funciona automático, Swagger escanea `src/index.js` y `src/routes/*.js`).

## Autenticación y roles

Better Auth está integrado y expone todo el ciclo de sesión en `/api/auth/*` (registro, login, logout, recuperación). No hace falta escribir esos endpoints a mano.

- **Configuración**: `src/lib/auth.js`. Si la tocás (agregar un plugin, un campo), después corré `npm run auth:generate` para regenerar las tablas en `src/db/schema.js`, y luego `npm run db:generate && npm run db:migrate`.
- **Roles y permisos**: `src/lib/permissions.js`. Los tres roles son `propietario`, `gerente`, `empleado` (RF9), y viven en la tabla `member` de Better Auth.
- **Middlewares** (`src/middlewares/auth.middleware.js`):

```js
import { requireAuth, requireRole, requirePermission } from "../middlewares/auth.middleware.js";

// Valida la sesión y deja en req: usuario, rol, comercioId
router.get("/", requireAuth, controller.listar);

// Restringe por rol
router.get("/auditoria", requireAuth, requireRole("propietario"), controller.listar);

// Restringe por permiso concreto (preferible: si cambia la matriz, la ruta no se entera)
router.delete("/:id", requireAuth, requirePermission({ producto: ["delete"] }), controller.eliminar);
```

- **Multi-tenant**: `requireAuth` deja `req.comercioId` tomado **de la sesión**. Toda query de negocio filtra por ese valor, y nunca por un `comercio_id` que venga del body o la query string.
- El rol **nunca** se valida con un `if` dentro de un controller — siempre por middleware.

## Tests y linter

```bash
npm test              # Jest (unitarios + integración con supertest)
npm run test:watch
npm run test:coverage
npm run lint          # ESLint
npm run lint:fix
```

Los tests viven en `tests/`. Los de integración importan `src/app.js` (la app sin `listen`), por eso no hace falta levantar el servidor para correrlos.

Jest corre sobre ESM con `NODE_OPTIONS=--experimental-vm-modules`, ya incluido en el script `npm test`. Si lo invocás con `npx jest` directo, va a fallar al importar los módulos.

## Manejo de secretos

- `.env` real: nunca se sube al repo, nunca se comparte por WhatsApp/Discord grupal.
- Para compartir el `DATABASE_URL` u otras claves entre el equipo, usar el gestor de contraseñas acordado o un canal privado 1 a 1.
- `.env.example` sí se commitea, y solo tiene nombres de variables con placeholders — nunca valores reales.

## Flujo de trabajo con Git

- **`main`**: versión estable, la que se muestra en cada Sprint Review. Protegida — nadie pushea directo.
- **`dev`**: rama de integración del Sprint en curso. También protegida — nadie pushea directo.
- Cada Historia de Usuario se desarrolla en su propia rama, creada desde `dev`:

```bash
  git checkout dev
  git pull origin dev
  git checkout -b feature/HU1-registro-usuario
```

- Al terminar, se abre un Pull Request hacia `dev` (no hacia `main`), asignando a otro integrante como reviewer.
- La promoción de `dev` → `main` la gestiona la persona a cargo de testing, una vez que los tests de integración (en el repo `Infraestructura`) pasan sobre el estado actual de `dev`.
- Después de mergear una feature branch, borrarla (GitHub lo ofrece con un botón automático al cerrar el PR).
- Nombrar los commits describiendo qué se hizo, no genéricos tipo "cambios".

## Troubleshooting

- **Warning de SSL al correr `drizzle-kit migrate`** ("SECURITY WARNING: The SSL modes..."): es una advertencia esperada por el modo `sslmode=require` de Neon, no es un error. Se puede ignorar.
- **`process.env.DATABASE_URL` da `undefined` en `drizzle.config.js`**: falta el `import "dotenv/config";` al principio del archivo.
- **Swagger muestra "No operations defined in spec!"**: revisar que el archivo con los comentarios `@openapi` esté incluido en el array `apis` de la configuración en `src/app.js`.
- **El registro devuelve 500 y el usuario se crea pero no puede loguearse**: el schema de Better Auth quedó desactualizado (típicamente falta `account.issuer`). Regenerar con `npm run auth:generate`. **Ojo**: el CLI viejo `@better-auth/cli` está deprecado y genera un schema de una versión anterior — el correcto es `npx auth@latest generate`, que ya está en el script.
- **`npx jest` falla al importar módulos**: el proyecto es ESM. Usar siempre `npm test`, que agrega `NODE_OPTIONS=--experimental-vm-modules`.
- **El Frontend no manda la cookie de sesión**: revisar que su origen esté en `TRUSTED_ORIGINS` del `.env`, y que el `fetch` del Frontend use `credentials: "include"`.
- **`drizzle-kit generate` se cuelga pidiendo confirmación**: detectó un posible rename de tabla y abre un prompt interactivo. Hay que correrlo en una terminal real, no desde un script o CI.