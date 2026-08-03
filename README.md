# Backend — Centralización y Optimización de la Gestión Comercial

API REST del proyecto. Node + Express + Drizzle ORM + PostgreSQL (Neon), con documentación Swagger.

## Stack

- **Node.js** (versión fijada en `.nvmrc`)
- **Express 5**
- **Drizzle ORM** + `pg` (driver de PostgreSQL)
- **Swagger** (`swagger-jsdoc` + `swagger-ui-express`) — documentación interactiva
- **Better Auth** (pendiente de integrar — ver `middlewares/auth.middleware.js`)
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

## Levantar el proyecto en desarrollo

```bash
npm run dev
```

Esto levanta el servidor con `nodemon` (reinicia solo ante cada cambio). Por defecto:

- API disponible en `http://localhost:4000`
- Documentación Swagger en `http://localhost:4000/api-docs`
- Endpoint de salud: `GET /health`

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
├── index.js              # arranca Express, monta Swagger y las rutas
├── db/
│   ├── client.js         # conexión a Postgres (Drizzle)
│   └── schema.js         # definición de tablas
├── routes/                # define endpoints (URL + método), documentación Swagger
├── controllers/           # recibe req/res, llama al service, devuelve la respuesta HTTP
├── services/               # lógica de negocio real, es lo único que habla con la base
└── middlewares/            # funciones que corren antes del controller (auth, roles, errores)
```

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

- El middleware `src/middlewares/auth.middleware.js` (`requireAuth`) todavía es un placeholder — deja pasar todo sin validar nada. Se completa cuando se integre Better Auth.
- Los tres roles del sistema son `propietario`, `gerente`, `empleado` (RF9). Cualquier ruta que deba restringirse por rol debe usar un middleware de verificación (a crear junto con la integración de Better Auth), **nunca** validar el rol manualmente dentro de cada controller.

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
- **Swagger muestra "No operations defined in spec!"**: revisar que el archivo con los comentarios `@openapi` esté incluido en el array `apis` de la configuración en `src/index.js`.