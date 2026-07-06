import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { CreditNote, NoteType } from '@/modules/credit-notes/entities/credit-note.entity';
import { CreditNoteLine } from '@/modules/credit-notes/entities/credit-note-line.entity';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

import type { ListSalesQueryDto } from '../dto/list-sales-query.dto';
import { SaleListItemDto } from '../dto/sale-list-item.dto';
import { SaleInvoice } from '../entities/sale-invoice.entity';
import { deriveTicketCredit } from '../internal/derive-ticket-credit';

/**
 * Lista ventas del feed del día. Espejo byte-por-byte de
 * `placepos/src/main/database/saleOperations.ts → getTickets`.
 *
 * --------------------------------------------------------------------------
 * Reglas de paridad con el modo servidor/cliente
 * --------------------------------------------------------------------------
 *
 *   - Filtro por fecha: por default, solo ventas creadas HOY. Si la query
 *     trae `date_from`/`date_to`, se respeta esa ventana (extensión cloud).
 *   - Filtro por scope: si el actor NO tiene el permiso `canViewAllSales`
 *     (Vendedor, empleado legacy), solo ve las ventas creadas por él
 *     (`created_by_id = actor.user_id`); owner/superadmin/Cajero ven todas.
 *   - Filtro por archivo: `is_deleted = false` salvo que llegue `show_deleted=true`.
 *   - Totales: consolidados (V + Σ ND − Σ NC) — paridad con `computeAdjustments`
 *     del local.
 *   - `customerName`: `customer_name || 'CONSUMIDOR FINAL'` para ventas
 *     mostrador.
 *   - `synced`: siempre true (el cloud no tiene cola offline).
 *
 * Multi-tenancy: filtro estricto por `company_id`.
 */
@Injectable()
export class FindAllSalesAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly salesRepo: Repository<SaleInvoice>,
    @InjectRepository(CreditNote)
    private readonly notesRepo: Repository<CreditNote>,
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
  ) {}

  async execute(
    companyId: number,
    query: ListSalesQueryDto,
    actor: AuthUser,
  ): Promise<SaleListItemDto[]> {
    const qb = this.salesRepo
      .createQueryBuilder('s')
      // `credit` (OneToOne) para el chip "Crédito" del feed. No multiplica filas.
      .leftJoinAndSelect('s.credit', 'credit')
      .where('s.company_id = :companyId', { companyId: String(companyId) })
      .orderBy('s.created_at', 'DESC');

    if (query.show_deleted !== true) {
      qb.andWhere('s.is_deleted = false');
    }
    if (query.ticket_type) {
      qb.andWhere('s.ticket_type = :ticketType', { ticketType: query.ticket_type });
    }
    if (typeof query.customer_id === 'number') {
      qb.andWhere('s.customer_id = :customerId', { customerId: String(query.customer_id) });
    }

    // Filtros de fecha: si vienen explícitos respetar, si no aplicar "today"
    // (paridad PlacePos: el modo servidor/cliente siempre limita a hoy).
    if (query.date_from) {
      qb.andWhere('s.created_at >= :dateFrom', { dateFrom: query.date_from });
    }
    if (query.date_to) {
      qb.andWhere(`s.created_at < (:dateTo::date + INTERVAL '1 day')`, { dateTo: query.date_to });
    }
    if (!query.date_from && !query.date_to) {
      qb.andWhere(`s.created_at >= date_trunc('day', now())`).andWhere(
        `s.created_at < date_trunc('day', now()) + INTERVAL '1 day'`,
      );
    }

    // Scope por `canViewAllSales` — paridad con `getTickets` local: un actor sin
    // ese permiso (Vendedor, empleado legacy) solo ve sus propias ventas;
    // owner/superadmin/Cajero ven todas.
    const effective = await this.resolvePermissions.execute({
      type: actor.type,
      account: actor.account,
      user_id: actor.user_id,
      company_id: actor.company_id,
    });
    if (!effective.includes('canViewAllSales')) {
      qb.andWhere('s.created_by_id = :actorId', { actorId: String(actor.user_id) });
    }

    if (typeof query.limit === 'number' && query.limit > 0) {
      qb.limit(query.limit);
    }

    const invoices = await qb.getMany();
    if (invoices.length === 0) {
      return [];
    }

    // Batch fetch de las credit_notes (CN + ND) asociadas a las ventas del
    // listado, con sus líneas, para consolidar totales.
    const saleIds = invoices.map((s) => s.id);
    const notes = await this.notesRepo.find({
      where: {
        company_id: String(companyId),
        sale_invoice_id: In(saleIds),
        is_deleted: false,
      },
      relations: { lines: true },
    });

    const notesBySale = new Map<string, CreditNote[]>();
    for (const note of notes) {
      const bucket = notesBySale.get(note.sale_invoice_id);
      if (bucket) {
        bucket.push(note);
      } else {
        notesBySale.set(note.sale_invoice_id, [note]);
      }
    }

    return invoices.map((inv) => buildListItem(inv, notesBySale.get(inv.id) ?? []));
  }
}

interface ConsolidatedTotals {
  total: number;
  cost: number;
  profit: number;
  margin: number;
}

/**
 * Aplica las notas (CN resta, ND suma) sobre los totales de la venta base.
 * Paridad con `computeAdjustments` del modo servidor/cliente.
 */
function consolidate(invoice: SaleInvoice, notes: CreditNote[]): ConsolidatedTotals {
  const credits = notes.filter((n) => n.note_type === NoteType.CREDIT);
  const debits = notes.filter((n) => n.note_type === NoteType.DEBIT);

  const creditTotal = credits.reduce((s, n) => s + Number(n.total), 0);
  const debitTotal = debits.reduce((s, n) => s + Number(n.total), 0);
  const consolidatedTotal = Number(invoice.total) - creditTotal + debitTotal;

  const creditCost = credits.reduce((s, n) => s + sumLineCost(n.lines), 0);
  const debitCost = debits.reduce((s, n) => s + sumLineCost(n.lines), 0);
  const consolidatedCost = Number(invoice.cost) - creditCost + debitCost;

  const consolidatedProfit = consolidatedTotal - consolidatedCost;
  const consolidatedMargin =
    consolidatedTotal > 0 ? (consolidatedProfit / consolidatedTotal) * 100 : 0;

  return {
    total: consolidatedTotal,
    cost: consolidatedCost,
    profit: consolidatedProfit,
    margin: consolidatedMargin,
  };
}

function sumLineCost(lines: CreditNoteLine[]): number {
  return lines.reduce((s, l) => s + Number(l.unit_cost) * Number(l.quantity), 0);
}

function buildListItem(invoice: SaleInvoice, notes: CreditNote[]): SaleListItemDto {
  const consolidated = consolidate(invoice, notes);
  const { isCredit, creditStatus } = deriveTicketCredit(invoice.credit);
  return {
    id: Number(invoice.id),
    ticketType: invoice.ticket_type,
    ticketNumber: invoice.ticket_number,
    saleNumber: invoice.sale_number,
    total: consolidated.total,
    cost: consolidated.cost,
    profit: consolidated.profit,
    margin: consolidated.margin,
    isCredit,
    creditStatus,
    customerName: invoice.customer_name || 'CONSUMIDOR FINAL',
    synced: true,
    createdAt: invoice.created_at.toISOString(),
  };
}
