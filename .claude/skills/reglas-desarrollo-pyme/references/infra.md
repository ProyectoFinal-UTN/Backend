# Infraestructura — convenciones

Repo `Infraestructura`: Nginx como reverse proxy + Docker Compose que orquesta Frontend + Backend + Nginx juntos. **No contiene código de la aplicación**, solo configuración y (a futuro) tests de integración.

## Para qué sirve y para qué no

`Frontend` y `Backend` corren cada uno de forma independiente en desarrollo (`npm run dev`, sin Docker). Este repo los une en un solo stack local para probar la integración completa y como evidencia de la arquitectura de contenedores.

**La producción real no usa este Nginx.** El despliegue decidido es: Backend en Render, Frontend en Vercel, cada uno como servicio independiente con su propio dominio y TLS gestionado por la plataforma. Si estás documentando o defendiendo la arquitectura, no describas este Docker Compose como "el despliegue" — es la integración local.

## Requisitos

- Docker Desktop corriendo (con backend WSL2 si es Windows).
- Los tres repos clonados como **carpetas hermanas**, no una dentro de otra.
- Un `.env` real en `Backend/` con `DATABASE_URL` — este repo no tiene `.env` propio, usa el del backend directamente.

## Comandos

```bash
docker compose up --build        # levanta todo, http://localhost (puerto 80)
docker compose down               # detiene todo
docker compose up --build backend # reconstruye solo un servicio (ej. tras pull de Backend)
```

## Enrutamiento (Nginx)

| Ruta | Va a | Sirve |
|---|---|---|
| `/` | `frontend` | Build estático de React |
| `/api/*` | `backend` | API REST |
| `/api-docs/*` | `backend` | Swagger |

`frontend` y `backend` no están expuestos directo — solo Nginx es el punto de entrada público, dentro de la red interna de Docker Compose.

## Tests de integración (pendiente)

Acá van a vivir los tests que necesitan todo el stack levantado (a diferencia de los unitarios, que viven cada uno en su repo). Candidato: Playwright, simulando el flujo real de un usuario contra `http://localhost`. Hasta que se defina el framework, `tests/` queda vacía como placeholder.

Este repo tiene un rol particular en la promoción `dev` → `main` de los tres repos: acá es donde corren esos tests de integración antes de aprobar la promoción (ver `references/git-workflow.md`).

## Troubleshooting conocido

- Falla el build de `frontend` o `backend`: confirmar que esos repos tienen su `Dockerfile` en la raíz y están clonados como hermanos, no anidados.
- Backend no arranca / no conecta a la base: falta `Backend/.env` con `DATABASE_URL` real.
- Errores intermitentes de conexión al levantar todo por primera vez: `depends_on` de Docker Compose solo espera a que el contenedor arranque, no a que el servicio esté sano. Reintentar `docker compose up` suele resolverlo; un `healthcheck` es la solución definitiva, pendiente de agregar.
- Cambios en código de Backend/Frontend que no se reflejan: hace falta `docker compose up --build` de nuevo, no alcanza con `docker compose up` (Docker usa la imagen del último build).
