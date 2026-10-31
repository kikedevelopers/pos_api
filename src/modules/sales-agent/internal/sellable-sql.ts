/**
 * Solo lo que el POS puede vender (mismas condiciones que el carrito): no
 * archivado, visible en el POS y de tipo simple o combo.
 */
export const SELLABLE_SQL =
  "p.is_archived = false AND p.show_in_pos = true AND p.product_type IN ('SIMPLE', 'COMBO')";
