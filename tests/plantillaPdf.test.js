import { describe, expect, test } from "@jest/globals";
import {
  esZonaHorariaValida,
  formatearFechaHora,
  generarPdfTabular,
  textoParaPdf,
} from "../src/lib/plantillaPdf.js";
import { leerPdf, ocurrencias, tieneFormaDePdf } from "./pdf.helper.js";

/**
 * Unitario de la plantilla PDF reutilizable (HU-25). No toca la base: arma
 * documentos con datos inventados y los vuelve a abrir con un parser real para
 * comprobar que son PDF validos y que dicen lo que tienen que decir.
 */

const ZONA = "America/Argentina/Buenos_Aires";

function reporteDePrueba(cambios = {}) {
  return {
    comercio: "Almacén Doña Ñata",
    titulo: "Reporte de prueba",
    generadoEn: new Date("2026-11-18T17:30:00.000Z"),
    zonaHoraria: ZONA,
    filtros: [["Rango aplicado", "01/09/2026 00:00 al 30/09/2026 23:59"]],
    columnas: [
      { titulo: "Descripción", peso: 3, valor: (f) => f.nombre },
      {
        titulo: "Unidades",
        peso: 1,
        alineacion: "right",
        valor: (f) => f.cantidad,
      },
    ],
    filas: [
      { nombre: "Café molido", cantidad: "+5" },
      { nombre: "Yerba Ñandú", cantidad: "-2" },
    ],
    totales: [["Movimientos", "2"]],
    notas: ["Montos no disponibles."],
    mensajeVacio: "No hay nada que mostrar.",
    ...cambios,
  };
}

describe("textoParaPdf", () => {
  test("respeta tildes, ñ, diéresis y los signos de apertura", () => {
    const texto = "Almacén Doña Ñata: ¿pingüino? ¡Sí! — 10 €";

    expect(textoParaPdf(texto)).toBe(texto);
  });

  test("compone una tilde que llega separada de su letra", () => {
    // "e" + acento combinable, como lo mandan algunos teclados.
    expect(textoParaPdf("Café")).toBe("Café");
  });

  test("reemplaza por ? lo que Helvetica no puede dibujar", () => {
    expect(textoParaPdf("Promo 😀 中")).toBe("Promo ? ?");
  });

  test("el signo menos tipográfico pasa a guion", () => {
    expect(textoParaPdf("−3")).toBe("-3");
  });

  test("tabulaciones a espacio, otros controles afuera, saltos de línea quedan", () => {
    expect(textoParaPdf("a\tb\u0007c\nd")).toBe("a bc\nd");
  });

  test("null y undefined son texto vacío; los números se convierten", () => {
    expect(textoParaPdf(null)).toBe("");
    expect(textoParaPdf(undefined)).toBe("");
    expect(textoParaPdf(42)).toBe("42");
  });
});

describe("formatearFechaHora y esZonaHorariaValida", () => {
  test("muestra el instante en la hora local de la zona pedida", () => {
    // 03:00 UTC es medianoche en Argentina (UTC-3).
    expect(
      formatearFechaHora(new Date("2026-09-01T03:00:00.000Z"), ZONA),
    ).toBe("01/09/2026 00:00");
    expect(formatearFechaHora(new Date("2026-09-01T03:00:00.000Z"), "UTC")).toBe(
      "01/09/2026 03:00",
    );
  });

  test("reconoce zonas IANA y rechaza lo que no lo es", () => {
    expect(esZonaHorariaValida(ZONA)).toBe(true);
    expect(esZonaHorariaValida("UTC")).toBe(true);
    expect(esZonaHorariaValida("Marte/Olympus")).toBe(false);
    expect(esZonaHorariaValida("")).toBe(false);
    expect(esZonaHorariaValida(["UTC"])).toBe(false);
  });
});

describe("generarPdfTabular — validez del PDF", () => {
  test("devuelve un Buffer con encabezado %PDF- y cierre %%EOF", async () => {
    const pdf = await generarPdfTabular(reporteDePrueba());

    expect(tieneFormaDePdf(pdf)).toBe(true);
  });

  test("un parser real lo abre", async () => {
    const pdf = await generarPdfTabular(reporteDePrueba());

    await expect(leerPdf(pdf)).resolves.toMatchObject({ paginas: 1 });
  });
});

describe("generarPdfTabular — contenido", () => {
  test("el encabezado trae comercio, título, fecha de generación y filtros", async () => {
    const { texto } = await leerPdf(await generarPdfTabular(reporteDePrueba()));

    expect(texto).toContain("Almacén Doña Ñata");
    expect(texto).toContain("Reporte de prueba");
    // 17:30 UTC son las 14:30 en Argentina.
    expect(texto).toContain("Fecha de generación: 18/11/2026 14:30");
    expect(texto).toContain(
      "Rango aplicado: 01/09/2026 00:00 al 30/09/2026 23:59",
    );
  });

  test("la tabla, los totales y las notas llegan con sus tildes", async () => {
    const { texto } = await leerPdf(await generarPdfTabular(reporteDePrueba()));

    expect(texto).toContain("Descripción");
    expect(texto).toContain("Café molido");
    expect(texto).toContain("Yerba Ñandú");
    expect(texto).toContain("Totales");
    expect(texto).toContain("Movimientos: 2");
    expect(texto).toContain("Montos no disponibles.");
  });

  test("el pie dice la página y el total de páginas", async () => {
    const { texto } = await leerPdf(await generarPdfTabular(reporteDePrueba()));

    expect(texto).toContain("Página 1 de 1");
  });

  test("sin filas muestra el mensaje y no dibuja la tabla", async () => {
    const { texto } = await leerPdf(
      await generarPdfTabular(reporteDePrueba({ filas: [] })),
    );

    expect(texto).toContain("No hay nada que mostrar.");
    expect(texto).not.toContain("Descripción");
    // El encabezado sigue: el PDF vacío también dice de qué y de cuándo es.
    expect(texto).toContain("Almacén Doña Ñata");
  });
});

describe("generarPdfTabular — paginado", () => {
  const muchasFilas = Array.from({ length: 150 }, (_, i) => ({
    nombre: `Producto número ${i + 1}`,
    cantidad: String(i + 1),
  }));

  test("corta en varias hojas y numera cada una sobre el total", async () => {
    const { texto, paginas } = await leerPdf(
      await generarPdfTabular(reporteDePrueba({ filas: muchasFilas })),
    );

    expect(paginas).toBeGreaterThan(1);
    for (let n = 1; n <= paginas; n += 1) {
      expect(texto).toContain(`Página ${n} de ${paginas}`);
    }
  });

  test("repite los títulos de columna en cada hoja y no pierde filas", async () => {
    const { texto, paginas } = await leerPdf(
      await generarPdfTabular(reporteDePrueba({ filas: muchasFilas })),
    );

    expect(ocurrencias(texto, "Descripción")).toBe(paginas);
    // Cada fila entera, una por renglón: el corte de hoja no se come ninguna.
    for (const fila of muchasFilas) {
      expect(texto).toContain(`${fila.nombre} ${fila.cantidad}\n`);
    }
  });

  test("una celda larga hace crecer su fila en vez de pisar la siguiente", async () => {
    const largo = "Galletitas surtidas ".repeat(12).trim();
    const { texto } = await leerPdf(
      await generarPdfTabular(
        reporteDePrueba({
          filas: [
            { nombre: largo, cantidad: "1" },
            { nombre: "Fila de abajo", cantidad: "2" },
          ],
        }),
      ),
    );

    expect(texto).toContain("Fila de abajo");
    expect(ocurrencias(texto, "Galletitas")).toBe(12);
  });
});
