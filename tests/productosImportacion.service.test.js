import { describe, expect, test } from "@jest/globals";
import {
  normalizarFilaCsv,
  parsearCatalogoCsv,
} from "../src/services/productosImportacion.service.js";

/**
 * Unitario puro de la lectura del CSV de HU-7 — no toca la base, igual que
 * `tests/productos.service.test.js` con `validarDatosProducto`. La importacion
 * real (que si toca la base) se cubre en `tests/importacion.test.js`.
 *
 * Lo que se prueba aca es lo que separa un CSV que el comercio puede subir tal
 * como lo tiene de uno que primero tiene que editar a mano: encabezados con
 * acentos, separador `;` de Excel es-AR, BOM, columnas de mas.
 */

const csv = (texto) => Buffer.from(texto, "utf8");

const ENCABEZADO = "nombre,codigo_barras,categoria,unidad_medida";

describe("parsearCatalogoCsv — lectura del archivo", () => {
  test("lee una fila simple y numera la línea del archivo", () => {
    const filas = parsearCatalogoCsv(
      csv(`${ENCABEZADO}\nCoca-Cola,7790895000782,Bebidas,unidad\n`),
    );

    expect(filas).toHaveLength(1);
    // 2 y no 1: el encabezado es la línea 1, que es como lo ve el usuario en
    // Excel.
    expect(filas[0].fila).toBe(2);
    expect(filas[0].datos.nombre).toBe("Coca-Cola");
    expect(filas[0].datos.codigoBarras).toBe("7790895000782");
  });

  test("acepta encabezados con acentos, mayúsculas y espacios", () => {
    const filas = parsearCatalogoCsv(
      csv("Nombre,Código de Barras,Categoría,Unidad Medida\nAgua,123456,Bebidas,l\n"),
    );

    expect(filas[0].datos).toMatchObject({
      nombre: "Agua",
      codigoBarras: "123456",
      categoria: "Bebidas",
      unidadMedida: "l",
    });
  });

  test("acepta encabezados en camelCase, como los nombra la API", () => {
    const filas = parsearCatalogoCsv(
      csv("nombre,codigoBarras,categoria,unidadMedida,stockActual\nAgua,123456,Bebidas,l,7\n"),
    );

    expect(filas[0].datos.codigoBarras).toBe("123456");
    expect(filas[0].datos.stockActual).toBe("7");
  });

  test("detecta el separador punto y coma que exporta Excel en es-AR", () => {
    const filas = parsearCatalogoCsv(
      csv("nombre;codigo_barras;categoria;unidad_medida\nAgua;123456;Bebidas;l\n"),
    );

    expect(filas).toHaveLength(1);
    expect(filas[0].datos.categoria).toBe("Bebidas");
  });

  test("descarta el BOM que antepone Excel al guardar como CSV UTF-8", () => {
    const filas = parsearCatalogoCsv(
      csv(`\uFEFF${ENCABEZADO}\nAgua,123456,Bebidas,l\n`),
    );

    // Sin manejo del BOM el primer encabezado no matchea y esto seria un 400
    // por "falta la columna nombre".
    expect(filas[0].datos.nombre).toBe("Agua");
  });

  test("respeta comas dentro de un campo entrecomillado", () => {
    const filas = parsearCatalogoCsv(
      csv(`${ENCABEZADO}\n"Yerba Playadito, 1kg",123456,Almacén,kg\n`),
    );

    expect(filas[0].datos.nombre).toBe("Yerba Playadito, 1kg");
  });

  test("ignora las columnas que no reconoce en vez de rechazar el archivo", () => {
    const filas = parsearCatalogoCsv(
      csv(`${ENCABEZADO},precio,proveedor\nAgua,123456,Bebidas,l,350,ACME\n`),
    );

    expect(filas).toHaveLength(1);
    expect(filas[0].datos.nombre).toBe("Agua");
  });

  test("una comilla suelta en el nombre no tumba el archivo entero", () => {
    // `TV 32" LED` en modo estricto es INVALID_OPENING_QUOTE y se lleva puesto
    // el archivo con 400, que es justo lo que HU-7 promete que no pasa.
    const filas = parsearCatalogoCsv(
      csv(`${ENCABEZADO}\nTV 32" LED,123456,Electro,unidad\n`),
    );

    expect(filas[0].datos.nombre).toBe('TV 32" LED');
  });

  test("sigue respetando las comillas escapadas de un campo entrecomillado", () => {
    const filas = parsearCatalogoCsv(
      csv(`${ENCABEZADO}\n"El ""Rey"" del pan",123456,Almacén,unidad\n`),
    );

    expect(filas[0].datos.nombre).toBe('El "Rey" del pan');
  });

  test("descarta las filas que traen solo separadores, sin contarlas como error", () => {
    // Excel las genera cuando alguien dio formato a celdas debajo de los datos.
    const filas = parsearCatalogoCsv(
      csv(`${ENCABEZADO}\nAgua,123456,Bebidas,l\n,,,\n,,,\n`),
    );

    expect(filas).toHaveLength(1);
    expect(filas[0].datos.nombre).toBe("Agua");
  });

  test("una columna `codigo` es un SKU interno y se ignora, no es el código de barras", () => {
    // Si `codigo` fuera alias de codigo_barras, el SKU pisaria al código real
    // y el producto se crearia con el código equivocado, en silencio.
    const filas = parsearCatalogoCsv(
      csv(
        "nombre,codigo,codigo_barras,categoria,unidad_medida\nAgua,SKU-99,7790895000782,Bebidas,l\n",
      ),
    );

    expect(filas[0].datos.codigoBarras).toBe("7790895000782");
  });

  test("dos columnas que apuntan al mismo campo se rechazan como ambiguas", () => {
    expect(() =>
      parsearCatalogoCsv(
        csv(
          "nombre,codigo_barras,ean,categoria,unidad_medida\nAgua,111111,222222,Bebidas,l\n",
        ),
      ),
    ).toThrow(/ambigua/i);
  });

  test("una fila con menos celdas que encabezados no rompe el archivo", () => {
    const filas = parsearCatalogoCsv(
      csv(`${ENCABEZADO}\nAgua,123456\nSoda,654321,Bebidas,l\n`),
    );

    // Se lee igual: la fila incompleta cae despues como error de fila, sin
    // frenar a la que si esta bien.
    expect(filas).toHaveLength(2);
    expect(filas[1].datos.nombre).toBe("Soda");
  });
});

describe("parsearCatalogoCsv — rechazos del archivo completo", () => {
  test("rechaza cuando no se envió archivo", () => {
    expect(() => parsearCatalogoCsv(undefined)).toThrow(/no se recibió/i);
  });

  test("rechaza un archivo vacío", () => {
    expect(() => parsearCatalogoCsv(csv("   \n"))).toThrow(/vacío/i);
  });

  test("rechaza cuando falta una columna obligatoria y dice cuál", () => {
    expect(() =>
      parsearCatalogoCsv(csv("nombre,categoria,unidad_medida\nAgua,Bebidas,l\n")),
    ).toThrow(/codigo_barras/);
  });

  test("rechaza un archivo con encabezados pero sin filas de datos", () => {
    expect(() => parsearCatalogoCsv(csv(`${ENCABEZADO}\n`))).toThrow(
      /ninguna fila de datos/i,
    );
  });

  test("rechaza un CSV con comillas sin cerrar", () => {
    expect(() =>
      parsearCatalogoCsv(csv(`${ENCABEZADO}\n"Agua,123456,Bebidas,l\n`)),
    ).toThrow(/no se pudo leer como csv/i);
  });

  test("rechaza un archivo con más filas que el máximo", () => {
    const filas = Array.from(
      { length: 1001 },
      (_, i) => `Producto ${i},10000${i},Bebidas,unidad`,
    ).join("\n");

    expect(() => parsearCatalogoCsv(csv(`${ENCABEZADO}\n${filas}\n`))).toThrow(
      /máximo es 1000/i,
    );
  });
});

describe("normalizarFilaCsv — conversión de texto a los tipos de HU-9", () => {
  test("recorta espacios y separa el nombre de la ubicación", () => {
    expect(
      normalizarFilaCsv({
        nombre: "  Coca-Cola  ",
        codigoBarras: " 7790895000782 ",
        categoria: "Bebidas",
        unidadMedida: "unidad",
        ubicacion: " Depósito ",
      }),
    ).toEqual({
      nombre: "Coca-Cola",
      codigoBarras: "7790895000782",
      categoria: "Bebidas",
      unidadMedida: "unidad",
      umbralMinimo: 0,
      stockActual: 0,
      ubicacionNombre: "Depósito",
    });
  });

  test("convierte los numéricos a `number`, que es lo que exige la validación", () => {
    const fila = normalizarFilaCsv({ umbralMinimo: "5", stockActual: " 20 " });

    expect(fila.umbralMinimo).toBe(5);
    expect(fila.stockActual).toBe(20);
  });

  test("una celda numérica vacía o ausente vale 0", () => {
    expect(normalizarFilaCsv({ stockActual: "" }).stockActual).toBe(0);
    expect(normalizarFilaCsv({}).umbralMinimo).toBe(0);
  });

  test("deja pasar crudo lo que no es un entero, para que lo rechace la validación de HU-9", () => {
    // Es el punto del ejercicio: si esto se convirtiera con `Number(...)`,
    // "abc" entraria como NaN y "1.5" como 1.5, salteando el chequeo de
    // `esEnteroNoNegativo` que HU-9 puso a proposito.
    expect(normalizarFilaCsv({ stockActual: "abc" }).stockActual).toBe("abc");
    expect(normalizarFilaCsv({ umbralMinimo: "1.5" }).umbralMinimo).toBe("1.5");
    expect(normalizarFilaCsv({ stockActual: "-3" }).stockActual).toBe("-3");
  });
});
