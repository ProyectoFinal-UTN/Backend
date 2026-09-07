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
- El `.dockerignore` excluye `.env` y `.git`. Sin él, el `COPY . .` del Dockerfile mete el `.env` real dentro de la imagen: cualquiera que tenga la imagen tiene las credenciales, aunque nunca vea el repositorio.
- `BETTER_AUTH_SECRET` es obligatoria y de al menos 32 caracteres; el arranque falla si no está. No es paranoia: cuando falta, Better Auth **no** deja el secreto vacío sino que cae en uno hardcodeado que está publicado en su código fuente, y solo se niega a arrancar si `NODE_ENV === "production"` — que en nuestra imagen no está definido. Sin ese chequeo el backend levantaría sin errores y con las sesiones firmadas por un secreto que cualquiera puede leer en GitHub.

## Correos y recuperación de contraseña (HU-3)

El proveedor es **Resend**, y todo el trato con él vive en `src/lib/correo.js`. Si mañana se cambia por otro, se toca ese archivo y nada más.

**Se puede probar el flujo sin configurar nada.** Resend no deja mandarle a cualquier dirección hasta tener un dominio propio verificado: sin dominio, solo acepta la casilla con la que se registró la cuenta. Todavía no tenemos dominio, así que `enviarCorreo` tiene un camino de respaldo — cuando el envío no es posible (no hay `RESEND_API_KEY`, o Resend rechaza la dirección), el correo **no se pierde**: se escribe entero en la consola del backend, con el link adentro.

```
──────────────────────────────────────────────────────────────────────
[correo] NO se envió (falta RESEND_API_KEY en el .env). Va el contenido para poder seguir:
  Para:   ana@kiosco.com
  Asunto: Recuperá tu contraseña

Entrá acá para elegir una nueva:
http://localhost:5173/restablecer?token=3yNskayFL7oEJGQD8XYAwCR4
──────────────────────────────────────────────────────────────────────
```

Copiás ese link al navegador y seguís desde ahí. El día que haya dominio verificado se saca `registrarEnConsola` y no hace falta tocar nada más.

`enviarCorreo` **nunca tira**. Que falle un correo no puede romper la operación que lo disparó, y en la recuperación es además un problema de seguridad: si el error se propagara, quien pidió la recuperación vería un fallo solo cuando el correo existe, y eso alcanza para averiguar quiénes están registrados. Devuelve si pudo o no, y quien llama decide.

**El flujo.** Better Auth maneja el ciclo del token (generarlo, guardarlo, validarlo, vencerlo) y expone `POST /api/auth/request-password-reset` y `POST /api/auth/reset-password`. Lo nuestro es el correo: a dónde apunta el link y qué dice (`src/services/recuperacion.service.js`).

- El link va **al Frontend** (`/restablecer?token=...`), no al backend. Better Auth ofrece una `url` propia que pasa por el backend para redirigir después; ese salto no aporta nada, porque la pantalla que pide la contraseña nueva vive en el Frontend. Para eso entrega el `token` por separado.
- Vence en **una hora** y se usa **una sola vez**.
- El pedido responde **200 siempre**, exista o no el correo. Si contestara distinto, alcanzaría con probar de a uno para averiguar quiénes tienen cuenta. Better Auth incluso simula la generación del token para que tampoco se filtre por el tiempo de respuesta.
- Cambiar la contraseña **cierra todas las sesiones abiertas** de esa cuenta (`revokeSessionsOnPasswordReset`). Es la mitad que suele faltar: si alguien recupera la cuenta porque se la habían tomado, cambiar la clave no sirve de nada mientras la sesión del intruso siga viva.

## Protección de credenciales y datos personales (HU-31)

**Contraseñas.** Se guardan con hash bcrypt de 12 rondas (RNF4), nunca en texto plano y nunca reversible. Better Auth usa scrypt por defecto: el hasher propio está enchufado en `src/lib/auth.js`, y cambiarlo más adelante invalidaría todas las contraseñas ya guardadas. El máximo es de 72 caracteres porque bcrypt ignora todo lo que pase de 72 bytes — sin ese tope, dos contraseñas largas que compartan el prefijo serían intercambiables y quien usara una frase larga tendría menos seguridad de la que cree. Ningún endpoint devuelve el hash.

**Tráfico.** `helmet` va montado antes que todo lo demás en `src/app.js`, para que las cabeceras apliquen también a las respuestas de error. Aporta HSTS (el navegador entra a este dominio solo por HTTPS) y `X-Content-Type-Options: nosniff`, y oculta el `X-Powered-By` que anunciaba "Express". La conexión a Neon exige TLS por `sslmode=require` en el `DATABASE_URL`; sin eso las credenciales y los datos viajarían en claro hasta la base.

**Datos personales — Ley 25.326.** La ley reconoce dos derechos y los dos tienen endpoint:

| Derecho | Endpoint | Qué hace |
|---|---|---|
| Acceso (art. 14) | `GET /api/mis-datos` | Devuelve como descarga todo lo que el sistema guarda de la persona: cuenta, comercios en los que participa, sesiones activas y actividad registrada. No incluye la contraseña, ni siquiera hasheada. |
| Supresión (art. 16) | `DELETE /api/mi-cuenta` | Da de baja la cuenta. |

**Por qué la baja anonimiza en vez de borrar la fila.** `movimiento.usuario_id` es `NOT NULL` con `ON DELETE RESTRICT`, porque el libro de movimientos es append-only y tiene que saber quién registró cada uno: un `DELETE` fallaría para cualquier usuario que haya movido stock, o sea para casi todos. La anonimización resuelve la tensión — se eliminan los datos que identifican a la persona (nombre, correo, imagen) y la fila queda para que el libro conserve su integridad. Un registro que ya no identifica a nadie deja de ser un dato personal, que es lo que la ley protege. Lo que sí se borra de verdad es el hash de la contraseña, los tokens y las sesiones: después de la baja no se puede volver a entrar.

La baja se rechaza con 409 si quien la pide es el único propietario de algún comercio, porque ese comercio quedaría sin nadie que pueda administrarlo y sin forma de recuperarlo desde la app. El mensaje dice qué hacer antes de reintentar.

Dos detalles de orden en `src/app.js` que son fáciles de romper sin darse cuenta, y están comentados ahí mismo:

- Las rutas de datos personales van **arriba** de `auditarCambios`. Si pasaran por el middleware, al terminar la respuesta de la baja se escribiría un evento de auditoría nuevo con el correo real de la persona, volviendo a meter el dato que se acaba de borrar.
- `requireAuth` en esas rutas va **ruta por ruta**, no con un `router.use`. El router se monta en `/api` a secas, así que un `router.use` correría en cualquier pedido a `/api/*` aunque no matcheara ninguna ruta suya, y como responde 401 en vez de seguir la cadena dejaría sin acceso a los endpoints públicos de los demás módulos.

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