/**
 * Fragmentos de SQL compartidos por las herramientas del asistente.
 *
 * Existen para que las reglas de "qué cuenta y qué no" estén escritas UNA vez y
 * se puedan probar sin base de datos. Una herramienta que se salte estos filtros
 * le entrega al modelo cifras que no cuadran con los informes de la app, y el
 * modelo las repite con total seguridad: el usuario ve una alucinación donde en
 * realidad hubo un `WHERE` incompleto.
 */

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
