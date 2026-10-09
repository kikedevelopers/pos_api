/**
 * Vista mínima de un producto para resolver su imagen EFECTIVA.
 */
export interface ImageLinkView {
  parent_id: number | null;
  use_parent_image?: boolean | null;
  /** Ruta de la imagen PROPIA (objeto en el bucket) o null. */
  image: string | null;
}

/**
 * Ruta EFECTIVA de la imagen de un producto, para firmar su URL.
 *
 * Una PRESENTACIÓN vinculada (`use_parent_image`) no tiene foto propia: su
 * imagen se resuelve en LECTURA desde la del producto base (`parentImageById`),
 * así nunca se comparte la ruta del objeto en el bucket y borrar/reemplazar la
 * del base no deja la presentación apuntando a la nada. El resto de productos
 * (bases, combos y presentaciones con imagen propia) usa su propia `image`.
 *
 * Si el padre no está en el mapa (p. ej. no vino en el listado filtrado) cae a
 * `null`: el front pinta el placeholder, nunca se rompe.
 */
export function effectiveImagePath(
  item: ImageLinkView,
  parentImageById?: Map<number, string | null>,
): string | null {
  if (item.use_parent_image === true && item.parent_id !== null && parentImageById) {
    return parentImageById.get(item.parent_id) ?? null;
  }
  return item.image;
}
