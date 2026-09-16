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
    files: ["tests/**/*.test.js", "tests/**/*.js"],
    ...jest.configs["flat/recommended"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.jest },
    },
  },
];
