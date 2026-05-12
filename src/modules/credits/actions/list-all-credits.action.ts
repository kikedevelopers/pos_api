import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreditItemDto } from '../dto/credit-response.dto';
import type {
  CreditKind,
  CreditStatusValue,
  ListCreditsQueryDto,
} from '../dto/list-credits-query.dto';

/**
 * Resultado del agregador (rows + total para paginación).
 */
export interface ListAllCreditsResult {
  items: CreditItemDto[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Forma "ancha" del row del UNION, antes de mapear al DTO. Usamos un tipo
 * con campos uniformes (en el SQL homogeneizamos columnas con `as`).
 */
interface RawCreditRow {
  kind: CreditKind;
  credit_id: string;
  reference_id: string;
  reference_number: string | null;
  counterparty_id: string;
  counterparty_name: string | null;
  total_amount: string;
  paid_amount: string;
  balance: string;
  status: CreditStatusValue;
  due_date: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Lista todos los créditos (sale + purchase) de la company en una sola vista
 * paginable. Equivalente a un endpoint hipotético `list-all-credits` que
 * combine las queries que PlacePos hace en `customer-history` y
 * `supplier-history` pero unificadas.
 *
 * --------------------------------------------------------------------------
 * Diseño SQL
 * --------------------------------------------------------------------------
 *
 *   - Usa `UNION ALL` entre `sale_credits` y `purchase_credits`. UNION ALL
 *     (vs UNION) porque NO hay riesgo de duplicados — son tablas disjuntas y
 *     UNION DISTINCT obligaría a un sort costoso.
 *
 *   - Cada rama selecciona el MISMO conjunto de columnas con tipos
 *     compatibles. Las columnas que solo existen en sale_credits
 *     (`due_date`) se sirven con `NULL::date` desde el lado de purchases para
 *     mantener el shape uniforme.
 *
 *   - JOIN con `sale_invoices`/`purchases` para extraer
 *     `ticket_number`/`purchase_number` y customer/supplier name (snapshot).
 *
 *   - **Multi-tenancy** (CRÍTICO): el filtro `company_id = $1` se aplica EN
 *     CADA rama del UNION. NO usar OR ni omitir — sería leak cross-tenant.
 *
 *   - Filtros opcionales se concatenan con AND. Si `type=sale` solo
 *     ejecutamos la rama de sales (sin UNION); idem `type=purchase`.
 *
 *   - Total = subquery `SELECT COUNT(*)` envolviendo el UNION antes de
 *     paginar — necesario para que el frontend sepa el grand-total.
 *
 *   - Paginación: `ORDER BY created_at DESC` (índice
 *     `(company_id, created_at)` cubre cuando aplica) + LIMIT/OFFSET.
 *
 * --------------------------------------------------------------------------
 * Performance
 * --------------------------------------------------------------------------
 *
 *   - Las dos tablas ya tienen índices `(company_id, ...)`. Si el dataset
 *     crece, considerar índice parcial `(company_id, created_at DESC)
 *     WHERE balance > 0` para acelerar el listado por defecto.
 *
 *   - **N+1**: NO hay — el JOIN con la tabla padre (sale_invoices/purchases)
 *     trae el reference_number y el name en la misma query.
 */
@Injectable()
export class ListAllCreditsAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(companyId: number, query: ListCreditsQueryDto): Promise<ListAllCreditsResult> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const kind = query.type ?? null;

    // Construimos parámetros nombrados manualmente para mantener legibilidad.
    // Postgres soporta $1, $2, ... posicionales que reusamos en ambas ramas.
    const params: unknown[] = [String(companyId)];
    const placeholder = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    // Filtros opcionales aplicables a una rama según `kind`.
    const saleWhere: string[] = [`sc.company_id = $1`];
    const purchaseWhere: string[] = [`pc.company_id = $1`];

    if (query.status) {
      const ph = placeholder(query.status);
      saleWhere.push(`sc.status = ${ph}::credit_status`);
      purchaseWhere.push(`pc.status = ${ph}::credit_status`);
    }
    if (query.customer_id !== undefined) {
      const ph = placeholder(String(query.customer_id));
      saleWhere.push(`sc.customer_id = ${ph}`);
    }
    if (query.supplier_id !== undefined) {
      const ph = placeholder(String(query.supplier_id));
      purchaseWhere.push(`pc.supplier_id = ${ph}`);
    }
    if (query.date_from) {
      const ph = placeholder(`${query.date_from}T00:00:00.000Z`);
      saleWhere.push(`sc.created_at >= ${ph}::timestamptz`);
      purchaseWhere.push(`pc.created_at >= ${ph}::timestamptz`);
    }
    if (query.date_to) {
      const ph = placeholder(`${query.date_to}T23:59:59.999Z`);
      saleWhere.push(`sc.created_at <= ${ph}::timestamptz`);
      purchaseWhere.push(`pc.created_at <= ${ph}::timestamptz`);
    }

    const salePart = `
      SELECT
        'sale'::text AS kind,
        sc.id::text AS credit_id,
        sc.sale_invoice_id::text AS reference_id,
        COALESCE(si.sale_number, si.ticket_number) AS reference_number,
        sc.customer_id::text AS counterparty_id,
        si.customer_name AS counterparty_name,
        sc.total_amount::text AS total_amount,
        sc.paid_amount::text AS paid_amount,
        sc.balance::text AS balance,
        sc.status AS status,
        sc.due_date AS due_date,
        sc.created_at AS created_at,
        sc.updated_at AS updated_at
      FROM sale_credits sc
      INNER JOIN sale_invoices si
        ON si.id = sc.sale_invoice_id
       AND si.company_id = sc.company_id
      WHERE ${saleWhere.join(' AND ')}
    `;

    const purchasePart = `
      SELECT
        'purchase'::text AS kind,
        pc.id::text AS credit_id,
        pc.purchase_id::text AS reference_id,
        p.purchase_number AS reference_number,
        pc.supplier_id::text AS counterparty_id,
        p.supplier_name AS counterparty_name,
        pc.total_amount::text AS total_amount,
        pc.paid_amount::text AS paid_amount,
        pc.balance::text AS balance,
        pc.status AS status,
        NULL::date AS due_date,
        pc.created_at AS created_at,
        pc.updated_at AS updated_at
      FROM purchase_credits pc
      INNER JOIN purchases p
        ON p.id = pc.purchase_id
       AND p.company_id = pc.company_id
      WHERE ${purchaseWhere.join(' AND ')}
    `;

    // UNION ALL only si no se filtra por tipo. Si tipo está fijado, solo
    // ejecutamos una rama para evitar trabajo de planner innecesario.
    let body: string;
    if (kind === 'sale') {
      body = salePart;
    } else if (kind === 'purchase') {
      body = purchasePart;
    } else {
      body = `${salePart}\nUNION ALL\n${purchasePart}`;
    }

    const countSql = `SELECT COUNT(*)::int AS count FROM (${body}) u`;
    const dataSql = `
      ${body}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)}
      OFFSET ${Number(offset)}
    `;

    const countResult = await this.dataSource.query<Array<{ count: number }>>(countSql, params);
    const total = countResult[0]?.count ?? 0;

    const rows = await this.dataSource.query<RawCreditRow[]>(dataSql, params);
    const items: CreditItemDto[] = rows.map((r) => ({
      kind: r.kind,
      credit_id: Number(r.credit_id),
      reference_id: Number(r.reference_id),
      reference_number: r.reference_number,
      counterparty_id: Number(r.counterparty_id),
      counterparty_name: r.counterparty_name,
      total_amount: Number(r.total_amount),
      paid_amount: Number(r.paid_amount),
      balance: Number(r.balance),
      status: r.status,
      due_date: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    }));

    return { items, total, limit, offset };
  }
}
