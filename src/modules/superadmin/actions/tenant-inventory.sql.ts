/**
 * SQL compartido por las acciones de inventario del panel superadmin
 * (`get-tenant-inventory` y `clear-tenant-inventory`), para que el resumen que
 * ve el admin y lo que realmente ocurre al vaciar se calculen con la MISMA
 * definición de "protegido".
 *
 * Todas las consultas reciben `$1 = company_id`.
 */

/** Productos de la company. Base de las dos CTE siguientes. */
export const PRODUCT_TREE_CTE = `
WITH RECURSIVE prod AS (
  SELECT id, parent_id, is_archived, stock, cost
  FROM products
  WHERE company_id = $1
)`;

/**
 * Marca cada producto como "protegido" (no se puede borrar, se archiva).
 *
 * Un producto está protegido si él mismo tiene historial de NEGOCIO —líneas de
 * venta, de compra, de nota de ajuste o movimientos de inventario— o si lo tiene
 * cualquier otro miembro de su ÁRBOL (base + presentaciones, a cualquier
 * profundidad). La propagación al árbol completo no es un capricho: `products.
 * parent_id` es FK NO ACTION, así que borrar un base cuyas presentaciones
 * sobreviven archivadas reventaría con violación de llave foránea.
 *
 * `product_cost_history` y `product_price_history` NO protegen: son historial
 * interno del producto y se borran con él (ver `clear-tenant-inventory`).
 *
 * La recursión lleva `depth` como cinturón de seguridad ante una jerarquía
 * cíclica (A → B → A) que colgaría la consulta.
 */
export const PRODUCT_PROTECTION_CTE = `
own_history AS (
  SELECT p.id,
         (EXISTS (SELECT 1 FROM sale_invoice_lines  sl WHERE sl.product_id = p.id)
       OR  EXISTS (SELECT 1 FROM purchase_lines     pl WHERE pl.product_id = p.id)
       OR  EXISTS (SELECT 1 FROM credit_note_lines  cl WHERE cl.product_id = p.id)
       OR  EXISTS (SELECT 1 FROM inventory_movements im WHERE im.product_id = p.id)) AS has_history
  FROM prod p
),
-- Raíz del árbol de cada producto (un producto sin padre —o cuyo padre no está
-- en esta company— es su propia raíz).
tree AS (
  SELECT p.id, p.id AS root_id, 0 AS depth
  FROM prod p
  WHERE p.parent_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM prod parent WHERE parent.id = p.parent_id)
  UNION ALL
  SELECT child.id, t.root_id, t.depth + 1
  FROM prod child
  JOIN tree t ON child.parent_id = t.id
  WHERE t.depth < 10
),
root_history AS (
  SELECT t.root_id, bool_or(h.has_history) AS protected
  FROM tree t
  JOIN own_history h ON h.id = t.id
  GROUP BY t.root_id
),
protection AS (
  SELECT p.id,
         coalesce(rh.protected, h.has_history, false) AS protected
  FROM prod p
  LEFT JOIN tree t         ON t.id = p.id
  LEFT JOIN root_history rh ON rh.root_id = t.root_id
  LEFT JOIN own_history h   ON h.id = p.id
)`;
