import PDFDocument from "pdfkit";

/**
 * Plantilla PDF reutilizable para los reportes exportables (HU-25, RF8).
 *
 * Arma siempre el mismo documento: encabezado (comercio, titulo, fecha de
 * generacion y filtros aplicados), una tabla que corta pagina sola y repite sus
 * titulos de columna, totales, notas al pie y, en cada hoja, un pie con
 * "Pagina X de Y". No sabe nada de movimientos: el reporte que la use le pasa
 * las columnas y las filas ya resueltas. Un reporte nuevo (stock valorizado,
 * auditoria) es otro llamado a `generarPdfTabular`, no otra plantilla.
 *
 * Vive en `lib/` y no en `services/` porque no toca la base ni tiene reglas de
 * negocio: es presentacion, como `correo.js` o `push.js`.
 *
 * Usa Helvetica, una de las 14 fuentes estandar que todo lector de PDF trae
 * incorporadas, asi que no hay archivos de fuente que versionar ni que copiar
 * a la imagen de Docker. La contra es que solo cubre la codificacion WinAnsi
 * (Latin-1 mas algunos signos): alcanza para todo el castellano, pero lo que
 * quede afuera saldria como basura. `textoParaPdf` lo limpia antes.
 */

const MARGEN = 40;
// Lugar reservado abajo de cada hoja para el pie. Va sumado al margen
// inferior, asi la tabla corta pagina antes de pisarlo.
const ALTO_PIE = 24;
const RELLENO_CELDA = 4;

const TAMANIO = {
  comercio: 16,
  titulo: 13,
  texto: 9,
  tabla: 8.5,
  seccion: 11,
  nota: 8,
  pie: 7.5,
};

const COLOR = {
  texto: "#111111",
  tenue: "#555555",
  linea: "#BBBBBB",
  fondoTitulos: "#E6E6E6",
  fondoAlterno: "#F5F5F5",
};

/**
 * Los signos de WinAnsi (cp1252) que no estan en Latin-1: van en 0x80-0x9F,
 * que en Unicode son caracteres de control, asi que hay que listarlos a mano.
 */
const EXTRAS_WINANSI = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/**
 * Deja un texto escribible con Helvetica.
 *
 * Pasa a NFC primero: una "é" que llega como "e" + tilde combinable (lo que
 * mandan algunos teclados de celular) es un caracter WinAnsi valido una vez
 * compuesta. Lo que la fuente no tiene (emojis, otros alfabetos) se reemplaza
 * por "?" en vez de salir como un garabato que no se sabe que era. Los saltos
 * de linea se respetan; el resto de los controles se descarta.
 */
export function textoParaPdf(valor) {
  if (valor === null || valor === undefined) {
    return "";
  }

  let limpio = "";

  for (const caracter of String(valor).normalize("NFC")) {
    const codigo = caracter.codePointAt(0);

    if (
      (codigo >= 0x20 && codigo <= 0x7e) ||
      (codigo >= 0xa0 && codigo <= 0xff) ||
      EXTRAS_WINANSI.has(caracter)
    ) {
      limpio += caracter;
    } else if (caracter === "\n") {
      limpio += "\n";
    } else if (/\s/u.test(caracter)) {
      limpio += " ";
    } else if (caracter === "−") {
      // El signo menos tipografico: un "-" comun dice lo mismo.
      limpio += "-";
    } else if (codigo >= 0x20) {
      limpio += "?";
    }
  }

  return limpio;
}

/** True si la zona horaria IANA existe en el runtime (ej. America/Argentina/Buenos_Aires). */
export function esZonaHorariaValida(zonaHoraria) {
  if (typeof zonaHoraria !== "string" || zonaHoraria === "") {
    return false;
  }

  try {
    new Intl.DateTimeFormat("es-AR", { timeZone: zonaHoraria });
    return true;
  } catch {
    return false;
  }
}

/**
 * "dd/mm/aaaa hh:mm" en la zona pedida.
 *
 * Por partes y no con `toLocaleString`: el formato de "es-AR" mete una coma y,
 * segun la version de ICU, espacios especiales entre fecha y hora. Armarlo a
 * mano deja siempre el mismo texto, que es lo que los tests comparan.
 */
export function formatearFechaHora(fecha, zonaHoraria) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("es-AR", {
      timeZone: zonaHoraria,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(fecha)
      .map((parte) => [parte.type, parte.value]),
  );

  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

/** Ancho util de la hoja, entre los dos margenes. */
function anchoUtil(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

/** Hasta donde se puede escribir en la hoja actual sin pisar el pie. */
function limiteInferior(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

/** Pasa de hoja si lo que sigue no entra en la actual. */
function asegurarEspacio(doc, alto) {
  if (doc.y + alto > limiteInferior(doc)) {
    doc.addPage();
  }
  doc.x = doc.page.margins.left;
}

/** "Etiqueta: valor", con la etiqueta en negrita. */
function escribirDato(doc, etiqueta, valor, tamanio) {
  doc
    .font("Helvetica-Bold")
    .fontSize(tamanio)
    .text(`${textoParaPdf(etiqueta)}: `, { continued: true })
    .font("Helvetica")
    .text(textoParaPdf(valor));
}

function dibujarEncabezado(doc, reporte) {
  doc.fillColor(COLOR.texto);
  doc
    .font("Helvetica-Bold")
    .fontSize(TAMANIO.comercio)
    .text(textoParaPdf(reporte.comercio));
  doc.moveDown(0.2);
  doc.fontSize(TAMANIO.titulo).text(textoParaPdf(reporte.titulo));
  doc.moveDown(0.6);

  const datos = [
    [
      "Fecha de generación",
      formatearFechaHora(reporte.generadoEn, reporte.zonaHoraria),
    ],
    ...(reporte.filtros ?? []),
  ];

  for (const [etiqueta, valor] of datos) {
    escribirDato(doc, etiqueta, valor, TAMANIO.texto);
  }

  doc.moveDown(0.6);
  doc
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.margins.left + anchoUtil(doc), doc.y)
    .lineWidth(0.75)
    .strokeColor(COLOR.linea)
    .stroke();
  doc.moveDown(0.8);
}

/**
 * Tabla con alto de fila variable: una celda con texto largo (el nombre de un
 * producto) hace crecer su fila en vez de pisar la de abajo. Cada fila se mide
 * antes de dibujarla, y si no entra en la hoja se pasa a la siguiente y se
 * repiten los titulos de columna.
 *
 * Las columnas reparten el ancho por `peso`, no en puntos: un reporte declara
 * proporciones y no tiene que saber el tamanio de la hoja.
 */
function dibujarTabla(doc, columnas, filas) {
  const izquierda = doc.page.margins.left;
  const ancho = anchoUtil(doc);
  const pesoTotal = columnas.reduce((suma, c) => suma + c.peso, 0);
  const anchos = columnas.map((c) => (ancho * c.peso) / pesoTotal);

  const medir = (textos, fuente) => {
    doc.font(fuente).fontSize(TAMANIO.tabla);

    return (
      Math.max(
        ...textos.map((texto, i) =>
          doc.heightOfString(texto || " ", {
            width: anchos[i] - 2 * RELLENO_CELDA,
          }),
        ),
      ) +
      2 * RELLENO_CELDA
    );
  };

  const dibujarFila = (textos, y, alto, fuente, fondo) => {
    if (fondo) {
      doc.rect(izquierda, y, ancho, alto).fill(fondo);
    }

    doc.fillColor(COLOR.texto).font(fuente).fontSize(TAMANIO.tabla);

    let x = izquierda;
    textos.forEach((texto, i) => {
      doc.text(texto, x + RELLENO_CELDA, y + RELLENO_CELDA, {
        width: anchos[i] - 2 * RELLENO_CELDA,
        align: columnas[i].alineacion ?? "left",
      });
      x += anchos[i];
    });

    doc
      .moveTo(izquierda, y + alto)
      .lineTo(izquierda + ancho, y + alto)
      .lineWidth(0.5)
      .strokeColor(COLOR.linea)
      .stroke();
  };

  const titulos = columnas.map((c) => textoParaPdf(c.titulo));
  const altoTitulos = medir(titulos, "Helvetica-Bold");
  const textosDe = (fila) => columnas.map((c) => textoParaPdf(c.valor(fila)));

  let y = doc.y;

  const ponerTitulos = () => {
    dibujarFila(titulos, y, altoTitulos, "Helvetica-Bold", COLOR.fondoTitulos);
    y += altoTitulos;
  };

  // Los titulos no se dejan solos al pie de una hoja: si con la primera fila
  // no entran, arrancan en la siguiente.
  const altoPrimera = medir(textosDe(filas[0]), "Helvetica");
  if (y + altoTitulos + altoPrimera > limiteInferior(doc)) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  ponerTitulos();

  filas.forEach((fila, indice) => {
    const textos = textosDe(fila);
    const alto = medir(textos, "Helvetica");

    if (y + alto > limiteInferior(doc)) {
      doc.addPage();
      y = doc.page.margins.top;
      ponerTitulos();
    }

    dibujarFila(
      textos,
      y,
      alto,
      "Helvetica",
      indice % 2 === 1 ? COLOR.fondoAlterno : null,
    );
    y += alto;
  });

  doc.x = izquierda;
  doc.y = y;
  doc.moveDown(1);
}

function dibujarMensajeVacio(doc, mensaje) {
  doc
    .fillColor(COLOR.texto)
    .font("Helvetica-Oblique")
    .fontSize(TAMANIO.seccion)
    .text(textoParaPdf(mensaje));
  doc.moveDown(1);
}

function dibujarTotales(doc, totales) {
  // El titulo con al menos dos renglones abajo: un "Totales" huerfano al pie
  // de la hoja no se lee.
  asegurarEspacio(doc, 60);
  doc
    .fillColor(COLOR.texto)
    .font("Helvetica-Bold")
    .fontSize(TAMANIO.seccion)
    .text("Totales");
  doc.moveDown(0.3);

  for (const [etiqueta, valor] of totales) {
    asegurarEspacio(doc, 14);
    escribirDato(doc, etiqueta, valor, TAMANIO.texto);
  }

  doc.moveDown(1);
}

function dibujarNotas(doc, notas) {
  doc.fillColor(COLOR.tenue).font("Helvetica-Oblique").fontSize(TAMANIO.nota);

  for (const nota of notas) {
    asegurarEspacio(doc, 12);
    doc.text(textoParaPdf(nota));
  }
}

/**
 * El pie de cada hoja, al final y no mientras se escribe: el "de Y" recien se
 * conoce cuando el documento termino. Por eso el documento se crea con
 * `bufferPages`, que deja volver a las hojas ya escritas.
 *
 * El pie va en la franja reservada debajo del margen inferior. pdfkit agrega
 * una hoja nueva si se escribe por debajo del margen, asi que mientras se
 * dibuja el pie el margen se baja a 0 y despues se restaura.
 */
function dibujarPies(doc, reporte) {
  const { start, count } = doc.bufferedPageRange();
  const leyenda = textoParaPdf(`${reporte.comercio} · ${reporte.titulo}`);

  for (let i = 0; i < count; i += 1) {
    doc.switchToPage(start + i);

    const izquierda = doc.page.margins.left;
    const ancho = anchoUtil(doc);
    const margenOriginal = doc.page.margins.bottom;
    const y = doc.page.height - MARGEN - TAMANIO.pie;

    doc.page.margins.bottom = 0;

    doc
      .moveTo(izquierda, y - 6)
      .lineTo(izquierda + ancho, y - 6)
      .lineWidth(0.5)
      .strokeColor(COLOR.linea)
      .stroke();

    doc.fillColor(COLOR.tenue).font("Helvetica").fontSize(TAMANIO.pie);
    doc.text(leyenda, izquierda, y, {
      width: ancho * 0.75,
      height: TAMANIO.pie + 2,
      ellipsis: true,
      lineBreak: false,
    });
    doc.text(`Página ${i + 1} de ${count}`, izquierda, y, {
      width: ancho,
      align: "right",
      lineBreak: false,
    });

    doc.page.margins.bottom = margenOriginal;
  }
}

/**
 * Genera el PDF de un reporte tabular y lo devuelve entero como Buffer.
 *
 *   await generarPdfTabular({
 *     comercio: "Almacén Doña Rosa",
 *     titulo: "Reporte de movimientos por período",
 *     generadoEn: new Date(),
 *     zonaHoraria: "America/Argentina/Buenos_Aires",
 *     filtros: [["Rango", "01/09/2026 00:00 al 30/09/2026 23:59"]],
 *     columnas: [{ titulo: "Cantidad", peso: 1, alineacion: "right", valor: (f) => f.cantidad }],
 *     filas: [...],
 *     totales: [["Movimientos", "12"]],
 *     notas: ["..."],
 *     mensajeVacio: "No hay datos para los filtros elegidos.",
 *   })
 *
 * Buffer y no stream hacia la respuesta: si algo falla a mitad de camino, el
 * cliente recibe un error JSON con su status y no un PDF cortado con 200. El
 * tamanio esta acotado por quien la llama (ver MAXIMO_FILAS_REPORTE).
 */
export function generarPdfTabular(reporte) {
  return new Promise((resolver, rechazar) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: MARGEN,
        left: MARGEN,
        right: MARGEN,
        bottom: MARGEN + ALTO_PIE,
      },
      bufferPages: true,
      info: {
        Title: reporte.titulo,
        Author: reporte.comercio,
        Creator: "Gestión Comercial PyME",
      },
    });

    const partes = [];
    doc.on("data", (parte) => partes.push(parte));
    doc.on("end", () => resolver(Buffer.concat(partes)));
    doc.on("error", rechazar);

    try {
      dibujarEncabezado(doc, reporte);

      const filas = reporte.filas ?? [];
      if (filas.length > 0) {
        dibujarTabla(doc, reporte.columnas, filas);
      } else {
        dibujarMensajeVacio(
          doc,
          reporte.mensajeVacio ?? "No hay datos para los filtros elegidos.",
        );
      }

      if (reporte.totales?.length > 0) {
        dibujarTotales(doc, reporte.totales);
      }
      if (reporte.notas?.length > 0) {
        dibujarNotas(doc, reporte.notas);
      }

      dibujarPies(doc, reporte);
      doc.end();
    } catch (error) {
      rechazar(error);
    }
  });
}
