/**
 * SQL compartido por las acciones de clientes del panel superadmin
 * (`get-tenant-customers` y `clear-tenant-customers`), para que el resumen que
 * ve el admin y lo que realmente ocurre al vaciar la lista se calculen con la
 * MISMA definición de "protegido".
 *
 * Un cliente está PROTEGIDO (no se puede borrar, se ARCHIVA) si tiene historial
 * de negocio: ventas (`sale_invoices`), créditos (`sale_credits`), notas de
 * ajuste (`credit_notes`) o anticipos (`customer_advances`). Son las cuatro —y
 * únicas— tablas con FK a `customers(id)`. Borrar un cliente con historial
 * rompería ese histórico: `sale_invoices`/`credit_notes` son FK SET NULL
 * (perdería el vínculo con el cliente en su venta/nota) y
 * `sale_credits`/`customer_advances` son FK RESTRICT (el DELETE ni siquiera
 * pasaría). Un cliente sin NADA de eso se BORRA físicamente.
 *
 * Todas las consultas reciben `$1 = company_id`.
 */
export const CUSTOMER_PROTECTION_CTE = `
WITH cust AS (
  SELECT id, is_archived
  FROM customers
  WHERE company_id = $1
),
protection AS (
  SELECT c.id,
         c.is_archived,
         (EXISTS (SELECT 1 FROM sale_invoices     si WHERE si.customer_id = c.id)
       OR  EXISTS (SELECT 1 FROM sale_credits      sc WHERE sc.customer_id = c.id)
       OR  EXISTS (SELECT 1 FROM credit_notes      cn WHERE cn.customer_id = c.id)
       OR  EXISTS (SELECT 1 FROM customer_advances ca WHERE ca.customer_id = c.id)) AS protected
  FROM cust c
)`;
