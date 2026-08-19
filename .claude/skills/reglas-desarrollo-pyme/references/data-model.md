# Modelo de datos — referencia rápida

Leé esto antes de tocar `src/db/schema.js`, escribir una migración, o modelar cualquier tabla nueva. El DER completo (con el diagrama Mermaid) vive en `DER.md` en el repo de documentación del proyecto; esto es el resumen operativo de las decisiones que no son obvias mirando el diagrama solo.

## Multi-tenant: `comercio_id` en todo

El sistema es multi-comercio: varios comercios conviven en la misma base. **Toda tabla de negocio** (`producto`, `ubicacion`, `proveedor`, `movimiento`, `transferencia`, `alerta`, `auditoria`) lleva una columna `comercio_id` que apunta a `comercio`.

- Ninguna query de lectura o escritura sobre estas tablas puede omitir el filtro por `comercio_id` del usuario logueado.
- Esto se resuelve en la capa de `service`, tomando el `comercio_id` desde la sesión (no desde un parámetro que mande el cliente — nunca confiar en un `comercio_id` que venga del body o la query string).
- `USER`, `SESSION`, `ORGANIZATION` y `MEMBER` las gestiona Better Auth. `COMERCIO` es una tabla propia, 1:1 con `ORGANIZATION`, para colgarle los datos del negocio (nombre, rubro, dirección, moneda) sin tocar el schema de Better Auth.
- El rol (`propietario` / `gerente` / `empleado`) es un atributo de `MEMBER`, no una tabla aparte.

## Stock: híbrido (ledger + caché), no un solo número

Esta es la decisión más importante del modelo y la que más rompe si no se respeta.

- **`MOVIMIENTO` es la fuente de verdad.** Es un libro append-only: cada compra, venta, ajuste, merma o transferencia es una fila que nunca se edita ni se borra. La `cantidad` se guarda **con signo** (entrada `+`, salida `−`).
- **`STOCK` es una caché del saldo actual**, una fila por `(producto, ubicacion)`. Se actualiza en la **misma transacción** que inserta el `MOVIMIENTO` — nunca por separado, nunca en un paso posterior.
- Invariante que siempre tiene que cumplirse: `STOCK.cantidad = SUM(MOVIMIENTO.cantidad)` para ese producto y esa ubicación. Si alguna vez hay dudas sobre la caché, se recalcula desde el libro.
- El stock total de un producto (HU-11) es la suma de sus filas en `STOCK` a través de las ubicaciones — no un campo aparte.

**Al escribir un endpoint que mueve stock** (registrar movimiento, transferir, ajustar): siempre dentro de una transacción de Drizzle que (1) inserta el `MOVIMIENTO` y (2) hace upsert sobre `STOCK`. Si el paso 2 falla, el paso 1 se revierte.

## Transferencias: dos movimientos ligados, no una fila con origen/destino

Una transferencia entre ubicaciones (HU-12) se modela como **dos filas en `MOVIMIENTO`** que comparten un `transferencia_id`:

- Una fila con `ubicacion = origen`, `cantidad = -N`
- Otra fila con `ubicacion = destino`, `cantidad = +N`
- `TRANSFERENCIA` guarda origen, destino y quién la hizo, una sola vez.

Por qué así y no con una sola fila con columnas `ubicacion_origen`/`ubicacion_destino`: con dos filas, el cálculo de stock de cualquier ubicación es siempre `SUM(cantidad)` sin casos especiales, y el historial filtrado por ubicación (HU-14) es un `WHERE ubicacion = X` limpio en vez de un `OR` entre origen y destino. Ver la conversación de diseño del Sprint 0 si hace falta el razonamiento completo — acá alcanza con seguir el patrón.

**Al implementar una transferencia**: crear `TRANSFERENCIA` + los dos `MOVIMIENTO` ligados, todo en una sola transacción. Validar que el origen tenga stock suficiente antes de confirmar.

## Ubicación es configurable, no un enum

`UBICACION` es una tabla (`comercio_id`, `nombre`), no un enum fijo de "local"/"depósito". Cada comercio define las suyas (HU-8). No hardcodear nombres de ubicación en el código de ningún repo.

## Producto ↔ Proveedor es N:M

Un producto puede tener varios proveedores y viceversa, vía la tabla `PRODUCTO_PROVEEDOR`. Al sugerir un proveedor para reponer un producto (alertas, E3), tener en cuenta que puede haber más de uno asociado.

## Resumen de tablas

| Tabla | Quién la gestiona | Nota |
|---|---|---|
| `USER`, `SESSION`, `ORGANIZATION`, `MEMBER` | Better Auth | No se tocan a mano |
| `COMERCIO` | Propia | 1:1 con `ORGANIZATION` |
| `UBICACION` | Propia | Configurable por comercio |
| `PRODUCTO` | Propia | `comercio_id`, `umbral_minimo` |
| `PROVEEDOR` | Propia | `comercio_id` |
| `PRODUCTO_PROVEEDOR` | Propia | N:M |
| `STOCK` | Propia | Caché, `(producto, ubicacion)` |
| `MOVIMIENTO` | Propia | Fuente de verdad, append-only, cantidad con signo |
| `TRANSFERENCIA` | Propia | Agrupa 2 `MOVIMIENTO` |
| `ALERTA` | Propia | Ciclo de vida: activa → resuelta |
| `AUDITORIA` | Propia | Solo lectura para rol `propietario` |
