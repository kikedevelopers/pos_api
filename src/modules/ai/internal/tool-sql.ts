/**
 * Fragmentos de SQL compartidos por las herramientas del asistente.
 *
 * Existen para que las reglas de "qué cuenta y qué no" estén escritas UNA vez y
 * se puedan probar sin base de datos. Una herramienta que se salte estos filtros
 * le entrega al modelo cifras que no cuadran con los informes de la app, y el
 * modelo las repite con total seguridad: el usuario ve una alucinación donde en
 * realidad hubo un `WHERE` incompleto.
 */

import { normalizeNameSql } from '@/modules/categories/internal/category-lookups';

/**
 * `LIKE` insensible a MAYÚSCULAS y a ACENTOS.
 *
 * El modelo (y el usuario) escriben "BELTRÁN" cuando en la base está "BELTRAN"
 * (o al revés). Un `LOWER(col) LIKE $x` solo iguala las mayúsculas y deja la
 * búsqueda sin resultados por una sola tilde. Normalizamos AMBOS lados con
 * `normalizeNameSql` (lower + btrim + translate de vocales acentuadas a su
 * base) — el mismo criterio con el que inventario y categorías hacen match — de
 * modo que la tilde deja de importar. `translate` no toca los comodines `%`, así
 * que el patrón (`%beltran%`) sobrevive la normalización del parámetro.
 *
 * @param column    Columna/expresión a comparar (p. ej. `c.name`).
 * @param paramExpr Placeholder del patrón ya con comodines (p. ej. `$2`).
 */
export const accentInsensitiveLike = (column: string, paramExpr: string): string =>
  `${normalizeNameSql(column)} LIKE ${normalizeNameSql(paramExpr)}`;

/**
 * Un crédito solo cuenta en la cartera si su factura sigue viva.
 *
 * Sin este JOIN se suman los créditos de ventas ANULADAS (`is_deleted = true`) y
 * de tickets que no son venta (pedidos), que es justo lo que hacía que el
 * asistente reportara una cartera muy por encima del informe de Cartera.
 *
 * Espeja `GetCreditsReportAction` (`/reports/credits`), que es la fuente
 * canónica de la cartera.
 */
export const OPEN_CREDIT_JOIN = `
  INNER JOIN sale_invoices si
    ON si.id = sc.sale_invoice_id
   AND si.company_id = sc.company_id`;

/**
 * Condiciones de un crédito PENDIENTE. `balance > 0` en vez de
 * `status <> 'PAID'`: es el mismo criterio del informe (el CHECK
 * `paid + balance = total` los hace equivalentes) y no depende de que el estado
 * se haya actualizado bien.
 */
export const OPEN_CREDIT_CONDITIONS = `
  sc.company_id = $1
  AND si.ticket_type = 'SALE'
  AND si.is_deleted = false
  AND sc.balance > 0`;

/** Totales de la cartera: saldo, créditos abiertos y clientes que deben. */
export const buildDebtorTotalsSql = (): string => `
  SELECT
    COALESCE(SUM(sc.balance), 0)   AS total_balance,
    COUNT(*)                       AS credits_count,
    COUNT(DISTINCT sc.customer_id) AS customers_count
  FROM sale_credits sc
  ${OPEN_CREDIT_JOIN}
  WHERE ${OPEN_CREDIT_CONDITIONS}`;

/** Deudores ordenados por saldo. `$2` = límite. */
export const buildTopDebtorsSql = (): string => `
  SELECT
    c.name,
    c.phone,
    SUM(sc.balance)    AS balance,
    COUNT(*)           AS credits,
    MIN(sc.created_at) AS oldest_date
  FROM sale_credits sc
  ${OPEN_CREDIT_JOIN}
  JOIN customers c ON c.id = sc.customer_id AND c.company_id = sc.company_id
  WHERE ${OPEN_CREDIT_CONDITIONS}
  GROUP BY c.id, c.name, c.phone
  ORDER BY SUM(sc.balance) DESC
  LIMIT $2`;

/**
 * Deuda de un cliente, como subconsulta correlacionada con el alias `c`.
 *
 * NO se usa `customers.balance`: esa columna no se mantiene al día (hay
 * negocios enteros con todos los clientes en 0 debiendo dinero de verdad). La
 * única fuente confiable son los créditos abiertos.
 *
 * `companyParam` es el placeholder que ya trae la query anfitriona (p. ej. `$1`).
 */
export const buildCustomerDebtSubquery = (companyParam: string): string => `(
    SELECT COALESCE(SUM(sc.balance), 0)
    FROM sale_credits sc
    INNER JOIN sale_invoices si
      ON si.id = sc.sale_invoice_id
     AND si.company_id = sc.company_id
    WHERE sc.customer_id = c.id
      AND sc.company_id = ${companyParam}
      AND si.ticket_type = 'SALE'
      AND si.is_deleted = false
      AND sc.balance > 0
  )`;

/**
 * Cuántas compras recientes (con su detalle) se adjuntan por proveedor.
 *
 * `purchasesSummary` cuenta TODAS las compras del proveedor; esta lista es solo
 * la ventana más reciente, para no inflar el prompt con el histórico completo.
 */
export const SUPPLIER_RECENT_PURCHASES = 15;

/**
 * Proveedores con su cartera por pagar y sus compras, para la herramienta
 * `search_suppliers` del asistente.
 *
 * Parámetros: `$1` company_id, `$2` patrón `%texto%` (o NULL para listar sin
 * filtrar) y `$3` límite de proveedores.
 *
 * Decisiones:
 *   - NO filtra `is_archived`: un proveedor archivado también debe poder
 *     consultarse (se marca con `is_archived` para que el asistente avise que ya
 *     no está activo y aun así entregue la información).
 *   - Multi-tenant estricto: company_id en el proveedor, en las compras, en los
 *     créditos y en las líneas.
 *   - `accumulated_debt` es la deuda canónica (la misma que suma el informe de
 *     Proveedores); el desglose por compra sale de `purchase_credits`.
 *   - Solo cuenta compras vivas (`is_deleted = false`), espejo del listado de
 *     Compras. `LEFT JOIN purchase_credits` por si alguna compra legada no tiene
 *     crédito: se cae al `total` de la compra.
 *   - Orden: activos antes que archivados, luego por mayor deuda.
 */
export const buildSearchSuppliersSql = (): string => `
  SELECT
    s.legal_name,
    s.broker,
    s.phone,
    s.address,
    s.doc_number,
    s.email,
    s.is_archived,
    s.accumulated_debt,
    s.credit_balance,
    s.payment_accounts,
    COALESCE(agg.purchases_count, 0) AS purchases_count,
    COALESCE(agg.total_purchased, 0) AS total_purchased,
    COALESCE(agg.total_paid, 0)      AS total_paid,
    COALESCE(agg.total_pending, 0)   AS total_pending,
    COALESCE(agg.pending_count, 0)   AS pending_count,
    COALESCE(agg.paid_count, 0)      AS paid_count,
    COALESCE(agg.received_count, 0)  AS received_count,
    recent.purchases
  FROM suppliers s
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)                                                       AS purchases_count,
      COALESCE(SUM(COALESCE(pc.total_amount, p.total)), 0)           AS total_purchased,
      COALESCE(SUM(COALESCE(pc.paid_amount, 0)), 0)                  AS total_paid,
      COALESCE(SUM(COALESCE(pc.balance, p.total)), 0)                AS total_pending,
      COUNT(*) FILTER (WHERE COALESCE(pc.balance, p.total) > 0)      AS pending_count,
      COUNT(*) FILTER (WHERE COALESCE(pc.balance, p.total) = 0)      AS paid_count,
      COUNT(*) FILTER (WHERE p.status = 'RECEIVED')                  AS received_count
    FROM purchases p
    LEFT JOIN purchase_credits pc
      ON pc.purchase_id = p.id AND pc.company_id = p.company_id
    WHERE p.supplier_id = s.id
      AND p.company_id = s.company_id
      AND p.is_deleted = false
  ) agg ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'number',         rp.purchase_number,
               'invoice_number', rp.invoice_number,
               'invoice_date',   rp.invoice_date,
               'created_at',     rp.created_at,
               'received',       rp.status = 'RECEIVED',
               'total',          COALESCE(rp.credit_total, rp.total),
               'paid',           COALESCE(rp.paid_amount, 0),
               'balance',        COALESCE(rp.balance, rp.total),
               'payment_status', COALESCE(rp.payment_status, 'PENDING'),
               'items',          rp.items
             )
             ORDER BY rp.created_at DESC
           ) AS purchases
    FROM (
      SELECT
        p.purchase_number,
        p.invoice_number,
        p.invoice_date,
        p.created_at,
        p.status,
        p.total,
        pc.total_amount     AS credit_total,
        pc.paid_amount,
        pc.balance,
        pc.status::text     AS payment_status,
        (
          SELECT jsonb_agg(
                   jsonb_build_object(
                     'name',     l.name,
                     'quantity', l.packaging_qty,
                     'total',    l.total
                   ) ORDER BY l.id
                 )
          FROM purchase_lines l
          WHERE l.purchase_id = p.id AND l.company_id = p.company_id
        ) AS items
      FROM purchases p
      LEFT JOIN purchase_credits pc
        ON pc.purchase_id = p.id AND pc.company_id = p.company_id
      WHERE p.supplier_id = s.id
        AND p.company_id = s.company_id
        AND p.is_deleted = false
      ORDER BY p.created_at DESC
      LIMIT ${SUPPLIER_RECENT_PURCHASES}
    ) rp
  ) recent ON true
  WHERE s.company_id = $1
    AND (
      $2::text IS NULL
      OR ${accentInsensitiveLike('s.legal_name', '$2')}
      OR ${accentInsensitiveLike("COALESCE(s.broker, '')", '$2')}
      OR ${accentInsensitiveLike("COALESCE(s.doc_number, '')", '$2')}
      OR ${accentInsensitiveLike("COALESCE(s.phone, '')", '$2')}
      OR ${accentInsensitiveLike("COALESCE(s.email, '')", '$2')}
    )
  ORDER BY s.is_archived ASC, s.accumulated_debt DESC, s.legal_name ASC
  LIMIT $3`;
