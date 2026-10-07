import js from "@eslint/js";
import globals from "globals";
import jest from "eslint-plugin-jest";

export default [
  { ignores: ["node_modules/**", "drizzle/**", "coverage/**"] },

  js.configs.recommended,

  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // La DoD prohibe console.log de debug. `warn` y `error` si sirven, y
      // el arranque del servidor en index.js usa console.log a proposito.
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  {
    files: ["src/index.js"],
    rules: { "no-console": "off" },
  },

  {
    // Una linea de console.info por consulta al LLM con lo que costo: el
    // credito del AI Gateway es uno solo para los tres integrantes. Se habilita
    // solo `info`, no `log`, para que el console.log de debug siga prohibido.
    // Los dos archivos que le hablan al modelo: HU-26 y HU-27.
    files: [
      "src/services/asistente.service.js",
      "src/services/asistente.recomendaciones.service.js",
    ],
    rules: { "no-console": ["warn", { allow: ["info", "warn", "error"] }] },
  },

  {
    files: ["tests/**/*.test.js", "tests/**/*.js"],
    ...jest.configs["flat/recommended"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.jest },
    },
  },
];
