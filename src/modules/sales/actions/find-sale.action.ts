import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { getCustomerPointsConfig } from '@/modules/app-settings/internal/customer-points-config';
import { CreditNote } from '@/modules/credit-notes/entities/credit-note.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';

import { SaleCredit } from '../entities/sale-credit.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice } from '../entities/sale-invoice.entity';
import { SalePayment } from '../entities/sale-payment.entity';
import {
  findSaleCredit,
  findSaleInCompany,
  findSaleLines,
  findSalePayments,
} from '../internal/sale-lookups';

/**
 * Agregado completo de una venta (cabecera + líneas + pagos + credit + NC/ND).
 * Espejo PlacePos `getTicketById` — `creditNotes[]` incluye `lines` y
 * `correction_source` para que el mapper construya el shape `documents[]` y
 * `voidCreditNote` que el TicketViewer del cliente consume.
 */
export interface SaleAggregate {
  sale: SaleInvoice;
  lines: SaleInvoiceLine[];
  payments: SalePayment[];
  credit: SaleCredit | null;
  creditNotes: CreditNote[];
  /**
   * Flag del sistema de PUNTOS de cliente (config per-company). El recibo del
   * TicketViewer (TicketReceipt) muestra los puntos solo si
   * `pointsEnabled && customerPoints != null`. Paridad PlacePos `getTicketById`.
   */
  pointsEnabled: boolean;
  /**
   * Saldo ACTUAL de puntos del cliente de la venta (`customers.points`). `null`
   * si la venta es de mostrador (sin `customer_id`) o si los puntos están
   * deshabilitados — no tiene sentido leer el saldo si no se va a mostrar.
   */
  customerPoints: number | null;
}

/**
 * Lee el detalle completo de una venta por id, dentro de la company.
 *
 * Anti-IDOR: el `findSaleInCompany` exige `company_id = $current`. Si el
 * id existe en otra company → 404 indistinguible de "no existe".
 *
 * N+1 mitigation: cargamos lines / payments / credit / credit_notes en
 * queries dedicadas con índices propios. Las credit_notes traen sus líneas y
 * `correction_source` eager via `relations` para que el mapper a DTO no
 * dispare más queries (paridad PlacePos getTicketById que carga todo en un
 * solo join).
 */
@Injectable()
export class FindSaleAction {
  constructor(
    @InjectRepository(SaleInvoice)
    private readonly repo: Repository<SaleInvoice>,
  ) {}

  async execute(
    id: number,
    companyId: number,
    options: { requireActive?: boolean } = {},
  ): Promise<SaleAggregate> {
    const manager = this.repo.manager;
    // El TicketViewer del cliente espera ver también las ventas anuladas
    // (`isDeleted: true`) para poder navegar a una venta con FULL_VOID activa
    // y mostrar el aviso. Paridad PlacePos `getTicketById`, que no filtra por
    // `is_deleted`. Por default desactivamos el filtro; el caller decide.
    const sale = await findSaleInCompany(manager, id, companyId, {
      requireActive: options.requireActive ?? false,
    });
    const saleId = Number(sale.id);
    const lines = await findSaleLines(manager, saleId, companyId);
    const payments = await findSalePayments(manager, saleId, companyId);
    const credit = await findSaleCredit(manager, saleId, companyId);

    // Carga eager de NC/ND + sus líneas + correction_source. Es N+1 a 3
    // niveles, pero TypeORM lo resuelve en 1 query con JOIN.
    const creditNotes = await manager.find(CreditNote, {
      where: {
        company_id: String(companyId),
        sale_invoice_id: sale.id,
      },
      relations: { lines: true, correction_source: true },
      order: { created_at: 'ASC' },
    });

    // Sistema de puntos: una sola lectura de config por request. Si está
    // habilitado y la venta tiene cliente, leemos el saldo ACTUAL de puntos
    // (filtrado por company_id — anti-IDOR). En cualquier otro caso → null,
    // evitando una lectura inútil. Paridad PlacePos `getTicketById`.
    const pointsConfig = await getCustomerPointsConfig(manager, companyId);
    const pointsEnabled = pointsConfig.enabled;
    let customerPoints: number | null = null;
    if (pointsEnabled && sale.customer_id) {
      const customer = await manager.findOne(Customer, {
        where: { id: sale.customer_id, company_id: String(companyId) },
        select: { points: true },
      });
      customerPoints = customer ? customer.points : null;
    }

    return { sale, lines, payments, credit, creditNotes, pointsEnabled, customerPoints };
  }
}
