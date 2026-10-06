# Asistente Inteligente y LLM — reglas de costo

Vale para cualquier cosa que toque el modelo de lenguaje: HU-26 (consulta en lenguaje natural), HU-27 (recomendaciones proactivas), HU-28 (modo degradado), y cualquier prueba del asistente.

## La cuenta es UNA SOLA y la pagamos los tres

El LLM se usa a través del **AI Gateway de Vercel**, con **una sola API key compartida** por los tres integrantes, que va en el `.env` como `LLM_API_KEY`. La cuenta tiene **US$ 5 de crédito gratis por mes**.

Si alguien lo agota, **el asistente deja de andar para los tres** hasta el mes siguiente. No rompe la app, porque cae a modo limitado (HU-28), pero nadie puede probar ni demostrar HU-26 o HU-27, y eso incluye la Sprint Review.

## Prohibido, sin excepciones

Esto vale para vos y para cualquier agente de IA que trabaje en el proyecto (Claude Code, Copilot, Cursor):

- **Nada de facturación en Vercel.** No comprar créditos (*Top up*), no prender **auto top-up**, no pasar el equipo de Hobby a **Pro**, no tocar medios de pago, no cambiar el *Spend Budget* de la key.
- **No usar modelos fuera de la lista** de `MODELOS_PERMITIDOS` en `Backend/src/lib/llm.js`. Nada de Pro, Opus, Sonnet ni GPT-5. Un `claude-opus-4` cuesta US$ 75 por millón de tokens de salida, **187 veces** el modelo más barato de la lista.
- **No crear API keys nuevas** ni usar *BYOK* sin acordarlo en el equipo.
- **No llamar al LLM real desde tests**, ni unitarios, ni de integración, ni E2E, ni en CI.
- **No escribir loops ni scripts que le hagan muchas preguntas al modelo** "para ver cómo responde".

Si una tarea parece requerir alguna de estas cosas, se frena y se pregunta en el grupo.

## El candado de modelos ya está en el código

`Backend/src/lib/llm.js` solo acepta los modelos de `MODELOS_PERMITIDOS`, todos con precio ≤ US$ 2,50 por millón de tokens de salida:

| Modelo | Entrada (US$/1M) | Salida (US$/1M) |
|---|---|---|
| `google/gemini-2.5-flash-lite` | 0,10 | 0,40 |
| `google/gemini-3.1-flash-lite` | 0,25 | 1,50 |
| `google/gemini-2.5-flash` (default) | 0,30 | 2,50 |

Si alguien pone otro en `LLM_MODELO`, el backend **no lo usa**: avisa en la consola y sigue con el default. Un test (`tests/llm.test.js`) falla si alguien agrega a la lista un modelo que supere el techo.

Agregar un modelo a la lista es una decisión del equipo, no de un `.env`. Va en un PR propio, con el precio y el motivo.

## Cuánto cuesta de verdad

Medido contra la cuenta real con `gemini-2.5-flash`: **entre US$ 0,0002 y 0,0004 por pregunta**. Los US$ 5 alcanzan para unas **15.000 consultas** por mes.

O sea: el uso normal de desarrollo no es el riesgo. El riesgo es **el error**: un modelo caro en un `.env`, un loop que no termina, un test que le pega al proveedor en cada `npm test`. Las reglas de arriba existen para eso.

## Cómo desarrollar sin gastar

- **Sin key, el backend anda igual.** Si `LLM_API_KEY` está vacía, el asistente contesta en modo limitado y el resto de la app funciona. Para trabajar en el frontend del asistente, en las reglas de HU-28 o en las consultas SQL, **no hace falta la key**.
- **Los tests mockean el borde.** El patrón está en `Backend/tests/asistente.service.test.js`: `jest.unstable_mockModule` sobre `src/lib/llm.js`, que es el único archivo que habla con el proveedor. La lógica corre de verdad y el modelo no se llama.
- **Las consultas se prueban sin el LLM.** Las funciones de `src/services/asistente.consultas.service.js` son SQL puro y no necesitan el modelo. HU-27 y HU-28 las reusan directamente.
- **Las pruebas en vivo son puntuales.** Dos o tres preguntas concretas para verificar algo, no una batería. Si hay que comparar modelos o prompts, se acuerda antes en el equipo.
- **Los E2E de Infraestructura no dependen del LLM real.** Se corren sin key (modo limitado) o contra un mock. Un E2E que llama al modelo gasta en cada corrida de CI.

## Cómo ver cuánto se gastó

Cada consulta deja una línea en la consola del backend:

```
[asistente] google/gemini-2.5-flash | 937 tokens entrada, 31 salida | ~US$ 0.00036
```

El saldo real de la cuenta, que es la fuente de verdad, sale de:

```bash
node --env-file=.env -e "fetch('https://ai-gateway.vercel.sh/v1/credits',{headers:{Authorization:'Bearer '+(process.env.LLM_API_KEY||process.env.AI_GATEWAY_API_KEY)}}).then(r=>r.json()).then(console.log)"
```

Devuelve `{"balance": "...", "total_used": "..."}`. Es una consulta de solo lectura y no gasta.

## Reglas de código

- **Todo pasa por `src/lib/llm.js`.** Ningún otro archivo importa `ai` ni llama al Gateway. Si HU-27 necesita el modelo, usa `consultarModelo()` de ahí, que ya trae el candado, el timeout, el tope de tokens y el reporte de costo.
- **No se tocan los topes sin acuerdo:** `maxRetries: 0`, `TOKENS_DE_SALIDA_MAXIMOS`, `PASOS_MAXIMOS`. Cada uno acota cuánto puede costar un solo pedido.
- **El `comercioId` nunca es un parámetro que el modelo pueda ver o elegir.** Entra por closure en cada herramienta (ver `armarHerramientas` en `asistente.service.js`). Es la regla multi-tenant aplicada al LLM.
