# Flujo de Git — común a los tres repos

Las mismas reglas aplican en `Backend`, `Frontend` e `Infraestructura`.

## Ramas

- **`main`**: versión estable, la que se muestra en cada Sprint Review. Protegida, nadie pushea directo.
- **`dev`**: rama de integración del Sprint en curso. También protegida, nadie pushea directo.
- Cada Historia de Usuario se desarrolla en su propia rama, creada desde `dev`:

```bash
git checkout dev
git pull origin dev
git checkout -b feature/HU1-registro-usuario
```

En `Infraestructura`, como las tareas no son HU de producto sino tareas técnicas, el prefijo es `chore/` en vez de `feature/`:

```bash
git checkout -b chore/nombre-descriptivo
```

## Convención de nombre de branch

`feature/HU<numero>-<slug-descriptivo>` para HU de producto (ej. `feature/HU13-registro-movimiento`), `chore/<slug>` para tareas de infraestructura o setup. El número de HU es el que aparece en Jira, así cualquiera puede ubicar la tarjeta correspondiente con solo mirar el nombre de la branch.

## Pull Requests

- Se abren siempre hacia `dev`, nunca hacia `main`.
- Se asigna a **otro integrante** como reviewer — nadie aprueba su propio PR.
- El review confirma, como mínimo, lo que pide la Definition of Done (ver `references/definition-of-done.md`): capas respetadas, filtro por `comercio_id`, validación de rol, tests en verde.
- Después de mergear, la branch se borra (GitHub lo ofrece con un botón al cerrar el PR).

## Promoción `dev` → `main`

La gestiona la persona a cargo de testing del Sprint, una vez que los tests de integración —que viven en el repo `Infraestructura`, corriendo contra el stack completo levantado con Docker Compose— pasan sobre el estado combinado de `dev` en los tres repos. Nadie promueve a `main` sin ese paso, aunque el propio código funcione en aislado.

## Commits

Descriptivos, que digan qué se hizo. Nada de "cambios", "fix", "wip", "asdf". Un commit debe poder leerse en el historial dentro de un mes y seguir siendo claro sobre qué cambió y por qué.

Ejemplos:
- Bien: `feat: registrar movimiento de stock con transacción atómica`
- Mal: `cambios en movimientos`
