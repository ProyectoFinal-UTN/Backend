import { PDFParse } from "pdf-parse";

/**
 * Lectura de PDFs para los tests de HU-25.
 *
 * Que el archivo empiece con `%PDF-` no alcanza para decir que es valido: un
 * documento cortado a la mitad tambien empieza asi. Por eso, ademas de mirar
 * el encabezado y el cierre (`%%EOF`), se abre con un parser real (pdf-parse,
 * sobre pdf.js de Mozilla) y se le saca el texto: si no parsea, el test falla,
 * y si parsea, se puede verificar que diga lo que tiene que decir.
 *
 * No termina en `.test.js`, asi que Jest no lo corre como suite.
 */

/** Encabezado y cierre de un PDF bien formado, sin parsearlo. */
export function tieneFormaDePdf(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.subarray(0, 5).toString("latin1") === "%PDF-" &&
    buffer.subarray(-32).toString("latin1").includes("%%EOF")
  );
}

/** Texto plano y cantidad de hojas del PDF. Tira si el archivo no parsea. */
export async function leerPdf(buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const resultado = await parser.getText();
    return { texto: resultado.text, paginas: resultado.total };
  } finally {
    await parser.destroy();
  }
}

/** Cuantas veces aparece un texto: para los titulos que se repiten por hoja. */
export function ocurrencias(texto, buscado) {
  return texto.split(buscado).length - 1;
}
