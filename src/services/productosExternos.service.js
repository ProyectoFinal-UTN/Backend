/**
 * Prellenado opcional del alta de productos con datos de Open Food Facts
 * (HU-9, enhancement desacoplable — no depende de HU-10 ni la afecta).
 *
 * Solo se usa cuando un codigo de barras no existe todavia en el catalogo del
 * comercio: se intenta sugerir `nombre`/`categoria` para que el usuario no
 * arranque el formulario vacio. Nunca es un punto de falla del alta: ante
 * cualquier error (sin match, timeout, red caida, JSON invalido) devuelve
 * `null` en vez de lanzar, y el flujo manual sigue funcionando igual.
 *
 * Atribucion pendiente: los datos de Open Food Facts son ODbL y exigen
 * atribuir la fuente donde se muestren campos derivados de su base (por
 * ejemplo, el `nombre`/`categoria` sugeridos). Falta decidir con Frontend
 * donde mostrarla (pie del formulario de alta, o ficha del producto) — no se
 * implementa ningun texto todavia, es una decision de diseño pendiente.
 */

const TIMEOUT_MS = 3000;

export async function buscarEnOpenFoodFacts(codigoBarras) {
  try {
    const respuesta = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${codigoBarras}.json`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );

    if (!respuesta.ok) {
      return null;
    }

    const datos = await respuesta.json();

    if (datos.status !== 1 || !datos.product) {
      return null;
    }

    // Recortado al largo de la columna `nombre`: Open Food Facts a veces
    // devuelve nombres largos (marca + variante + presentacion todo junto), y
    // una sugerencia que la propia validacion del alta va a rechazar por
    // larga es peor que una recortada.
    const nombre = datos.product.product_name?.trim().slice(0, 150) || null;
    // "categories" en Open Food Facts es texto libre separado por comas; se
    // toma solo la primera como sugerencia simple, recortada al largo de la
    // columna `categoria`.
    const categoria =
      datos.product.categories?.split(",")[0]?.trim().slice(0, 100) || null;

    if (!nombre && !categoria) {
      return null;
    }

    return { nombre, categoria };
  } catch {
    console.warn(
      `[productosExternos] no se pudo consultar Open Food Facts para el código ${codigoBarras}`,
    );
    return null;
  }
}