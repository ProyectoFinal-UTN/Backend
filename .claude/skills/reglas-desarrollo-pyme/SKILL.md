---
name: reglas-desarrollo-pyme
description: 'Reglas y convenciones de desarrollo del proyecto final "Centralización y Optimización de la Gestión Comercial mediante Asistencia Inteligente" (SaaS de gestión de stock para comercios). Cúbrela SIEMPRE que se escriba, revise o refactorice código en los repos Frontend, Backend o Infraestructura del equipo, incluyendo: crear una pantalla o endpoint, agregar un módulo/Épica, tocar el schema de la base, nombrar una branch o un commit, abrir un Pull Request, o modelar cualquier tabla. Úsala también cuando alguien pregunte "cómo hago X en este proyecto", "dónde va este archivo", "cómo nombro esta rama", o cualquier duda sobre la estructura de carpetas, el flujo de Git, o el modelo de datos. El objetivo es que los tres integrantes trabajen bajo las mismas reglas y no haya conflictos al mergear.'
---

# Reglas de desarrollo — Gestión Comercial PyME

Este proyecto lo desarrollan tres integrantes en paralelo, repartiendo el trabajo por Historia de Usuario (cada uno hace backend + frontend + testing de sus HU). Para que el código de los tres encaje sin fricción al mergear, **todos siguen estas mismas reglas**. Cuando trabajes en cualquiera de los tres repos, respetá lo que está acá; ante la duda, esta skill manda sobre la improvisación.

Hay tres repos, clonados como carpetas hermanas al mismo nivel:

```
Desarrollo/
├── Backend/          # API REST — Node + Express + Drizzle + PostgreSQL (Neon)
├── Frontend/         # SPA — React + Vite + Tailwind v4
└── Infraestructura/  # Docker Compose + Nginx (solo integración local)
```

## Lo que nunca se rompe (reglas transversales)

Estas valen en los tres repos. El resto de la skill las desarrolla, pero si te llevás solo esto, que sea esto:

1. **Nunca se saltea una capa.** Backend: `routes → controller → service → db`. Frontend: `página → service → api.js → backend`. Una ruta jamás llama directo a la base; una página jamás hace `fetch` directo. La lógica de negocio vive en `services/`.
2. **Una branch por Historia de Usuario, PR hacia `dev`, nunca hacia `main`.** `main` y `dev` están protegidas: nadie pushea directo. Ver [references/git-workflow.md](references/git-workflow.md).
3. **El `.env` real nunca se commitea ni se comparte por chat grupal.** Solo se versiona `.env.example` con placeholders. El `DATABASE_URL` de Neon se pasa 1 a 1 o por gestor de contraseñas.
4. **El backend filtra siempre por `comercio_id`** (multi-tenant) y **valida el rol en un middleware, nunca a mano dentro del controller.** Ver [references/data-model.md](references/data-model.md) y la sección de auth.
5. **Commits descriptivos**, que digan qué se hizo — no "cambios", "arreglos", "wip".
6. **Docker es solo para integración local.** Producción es Backend en Render + Frontend en Vercel, cada uno independiente. No asumas Nginx en producción.

## Cómo elegir qué leer

- Vas a tocar **el modelo de datos, una tabla, el schema de Drizzle, o modelar algo nuevo** → leé [references/data-model.md](references/data-model.md) antes de escribir. El DER ya está decidido y tiene reglas no obvias (stock híbrido, transferencias, multi-tenant).
- Vas a trabajar en **el Backend** (endpoint, módulo, migración, auth) → leé [references/backend.md](references/backend.md).
- Vas a trabajar en **el Frontend** (pantalla, componente, llamada a la API, estilos) → leé [references/frontend.md](references/frontend.md).
- Vas a **nombrar una branch, hacer un commit, abrir un PR, o promover a `main`** → leé [references/git-workflow.md](references/git-workflow.md).
- Vas a tocar **Docker, Nginx, o levantar el stack completo** → leé [references/infra.md](references/infra.md).

No hace falta leer todo siempre. Abrí el archivo que corresponde a lo que estás por hacer. Si estás por crear un módulo completo (endpoint + pantalla), vas a necesitar backend.md, frontend.md y data-model.md.

## Naming y consistencia entre los tres

Cuando un mismo concepto aparece en los tres repos, se nombra igual en todos, respetando el DER como fuente de verdad de los nombres de entidad:

- Entidades del dominio: `producto`, `movimiento`, `ubicacion`, `proveedor`, `comercio`, `stock`, `alerta`. En singular para la entidad, plural para la colección/ruta (`/api/productos`).
- Roles del sistema: exactamente `propietario`, `gerente`, `empleado` (así, en minúscula, sin tilde en "empleado" que no la lleva). Definidos en RF9.
- Los archivos de un módulo comparten el nombre base: `productos.routes.js`, `productos.controller.js`, `productos.service.js` en el back; `productos.js` (service) y `Productos.jsx` (página) en el front.

Cuando agregues un concepto nuevo, elegí el nombre una vez y usalo idéntico en back, front y base. La divergencia de nombres es la causa más silenciosa de conflictos al integrar.

## Antes de dar una HU por terminada (Definition of Done)

Una Historia no se marca "Finalizada" hasta cumplir la DoD del equipo. El detalle completo está en [references/definition-of-done.md](references/definition-of-done.md), pero el resumen es: código en su branch con PR revisado por un par, pasa el linter, tests unitarios de la lógica escritos y en verde, criterios de aceptación de la HU verificados uno por uno, endpoint documentado, y —transversal— valida sesión/rol y filtra por `comercio_id`.
