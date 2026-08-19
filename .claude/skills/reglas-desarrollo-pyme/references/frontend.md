# Frontend — convenciones

Stack: React + Vite + Tailwind CSS v4 (vía plugin, sin config aparte) + React Router.

## Regla del flujo — innegociable

```
página (pages/) → service (services/) → api.js → backend
```

**Ninguna página llama a `fetch` directo.** Toda llamada a la API pasa por un `service`, que a su vez usa `api.js`. Esto es lo que permite que cambiar la URL base del backend (por ejemplo al pasar de desarrollo a producción) sea un cambio en un solo lugar.

Nunca hardcodear la URL del backend en el código — siempre rutas relativas (`/api/productos`). En desarrollo, el proxy de Vite (`vite.config.js`, `server.proxy`) redirige `/api/...` a `http://localhost:4000`. En producción, el frontend vive en Vercel como sitio estático y `/api/...` apunta a la URL pública del backend en Render.

## Estructura de carpetas

```
src/
├── assets/       # imágenes, íconos
├── components/   # UI reutilizable entre varias páginas
├── hooks/        # lógica reutilizable (ej: useAuth)
├── pages/        # una por pantalla (Login, Dashboard, Productos, ...)
├── services/     # funciones que llaman a la API, usan api.js
```

## Agregar una pantalla nueva (una Épica nueva)

Mismo patrón que ya está armado para `Login`:

1. `src/services/<modulo>.js`:
   ```js
   import { apiFetch } from "./api";
   export function obtenerProductos() {
     return apiFetch("/productos");
   }
   ```
2. `src/pages/<Modulo>.jsx` usando ese service.
3. Si ya está en uso React Router (arranca cuando haya navegación real entre pantallas), agregar la ruta en el archivo de `<Routes>`.

## Estilos — Tailwind v4

- No hay `tailwind.config.js` ni `postcss.config.js`. Se integra vía el plugin `@tailwindcss/vite` en `vite.config.js`.
- Clases utilitarias directo en `className`.
- Personalización (colores, fuentes) va con `@theme` dentro de `src/index.css`, no en un archivo de config aparte.
- `src/index.css` debe tener `@import "tailwindcss";` — las 3 líneas viejas `@tailwind base/components/utilities` son de la v3 y no van acá.

## Variables de entorno

Este repo no necesita `.env` en condiciones normales — nunca maneja secretos. Si hace falta una variable pública (un flag de feature, no una clave), usar el prefijo `VITE_`; queda expuesta en el build final, así que **nunca** poner ahí algo sensible.

## Desarrollo del día a día

```bash
npm run dev   # app en :5173, con el backend corriendo en paralelo en :4000
```

Docker en este repo tampoco es para el día a día — es multi-etapa (compila con Node, sirve con un Nginx propio liviano que solo sirve estáticos, distinto del Nginx de `Infraestructura`). Se usa junto con Backend y Nginx desde `docker-compose.yml` en `Infraestructura`.

## Troubleshooting conocido

- `npx tailwindcss init -p` falla con "could not determine executable to run": esperado en v4, no hace falta correrlo — ya está configurado vía `@tailwindcss/vite`.
- Instalar un paquete con scope sin la `@` (ej. `tailwindcss/vite` en vez de `@tailwindcss/vite`) hace que npm intente clonarlo como repo de GitHub y falle.
- `type nul >` no crea un archivo vacío en Git Bash (es de `cmd.exe`) — usar `touch nombre-del-archivo`.
- Estilos de Tailwind que no aplican: revisar que `src/index.css` tenga el `@import` de v4 y no las líneas viejas de v3.
