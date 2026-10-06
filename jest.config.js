/**
 * Jest sobre ESM.
 *
 * El backend es `"type": "module"`, asi que Jest necesita correr con
 * `NODE_OPTIONS=--experimental-vm-modules` (ya esta en el script `npm test`)
 * y sin transform: Node ejecuta los modulos tal cual, sin Babel.
 */
export default {
  testEnvironment: "node",
  transform: {},
  testMatch: ["**/tests/**/*.test.js"],
  // Corre antes de cada archivo de test, y por lo tanto antes de que `app.js`
  // importe `dotenv/config`: deja la key del LLM en vacio para que ningun test
  // le pueda hablar al proveedor real. Ver el archivo para el por que.
  setupFiles: ["<rootDir>/tests/jest.setup.js"],
  // Los tests de integracion registran usuarios contra Neon: bcrypt con 12
  // rondas mas la latencia de red no entran en los 5 segundos por defecto.
  testTimeout: 30000,
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/index.js",
    "!src/db/schema.js",
  ],
  clearMocks: true,
};
