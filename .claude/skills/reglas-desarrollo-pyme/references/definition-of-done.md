# Definition of Done (DoD) del equipo

Una Historia de Usuario se considera **"Listo"** cuando cumple todos los siguientes criterios. Esto aplica sin importar quién la desarrolló ni cuán simple parezca — es el contrato de calidad que sostiene que el trabajo de los tres se integre sin sorpresas.

## Código

- El código está en una branch dedicada a la HU (ver `references/git-workflow.md`), no directo en `dev`.
- Al menos un integrante **distinto al autor** revisó y aprobó la Pull Request.
- El código pasa el linter (ESLint) sin errores ni warnings no justificados.
- No hay código comentado, `console.log` de debug, ni credenciales hardcodeadas.

## Pruebas

- Las pruebas unitarias de la lógica de negocio están escritas y pasan al 100%.
- Las rutas de API involucradas tienen al menos un test de integración (request → response esperada).
- El pipeline de CI (cuando esté activo) pasa en verde.

## Funcionalidad

- La funcionalidad es demostrable en una sesión en vivo, sin intervención del desarrollador.
- Se verificaron los Criterios de Aceptación de la HU, **uno por uno**, y todos pasan.
- El flujo es operable desde dispositivo móvil (responsive, mobile-first) — el proyecto es para comerciantes que van a usarlo desde el celular.

## Documentación

- El endpoint nuevo o modificado está documentado con comentarios `@openapi` (ver `references/backend.md`).
- Si la HU cambió el modelo de datos, la migración de Drizzle está generada y probada (`npx drizzle-kit generate` + `migrate`).

## Seguridad (transversal, aplica siempre que la HU toque un endpoint)

- El endpoint valida sesión y rol del usuario vía el middleware de Better Auth — nunca a mano en el controller.
- Los datos se filtran por `comercio_id` del usuario logueado (ver `references/data-model.md`).

Si una HU no cumple alguno de estos puntos, no se marca como "Finalizada" en el Sprint — vuelve a "En progreso" con un comentario de qué falta.
