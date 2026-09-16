import { app } from "./app.js";

const PORT = process.env.PORT || 4000;

// La app vive en app.js y aca solo se levanta el servidor: asi los tests de
// integracion pueden importar `app` con supertest sin abrir un puerto.
app.listen(PORT, () => {
  console.log(`Backend corriendo en http://localhost:${PORT}`);
  console.log(`Swagger UI disponible en http://localhost:${PORT}/api-docs`);
});
