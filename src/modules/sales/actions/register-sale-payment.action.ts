import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';

import type { CreateSalePaymentDto } from '../dto/create-sale-payment.dto';
import { SaleCredit, SaleCreditStatus } from '../entities/sale-credit.entity';
import { SaleInvoice } from '../entities/sale-invoice.entity';
import { SalePayment } from '../entities/sale-payment.entity';
import {
  applySalePayment,
  loadSaleForUpdate,
  type SalePaymentActor,
} from '../internal/apply-sale-payment';
import { findSaleCredit, findSaleLines, findSalePayments } from '../internal/sale-lookups';
import type { SaleAggregate } from './find-sale.action';

/**
 * Resultado: incluye flag `idempotent` para que el controller responda
 * 201 (pago nuevo) o 200 (uuid ya procesado).
 */
export interface RegisterSalePaymentResult {
  aggregate: SaleAggregate;
  payment: SalePayment;
  idempotent: boolean;
}

/**
 * Registra un cobro a una venta existente. Espejo de
 * `POST /sales/:id/payments` de PlacePos.
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos
 * --------------------------------------------------------------------------
 *
 *   1. Lock pessimistic_write sobre `sale_invoices` (id + company_id) para
 *      serializar pagos concurrentes sobre la misma venta y evitar race
 *      con conversiones/anulaciones.
 *
 *   2. Cargar SaleCredit (si existe) con lock pessimistic_write —
 *      necesario para actualizar `balance/paid_amount/status` sin race.
 *
 *   3. Validar saldo solicitado <= balance pendiente (si hay credit).
 *      Si la venta era de contado (sin credit), validar amount <= total
 *      (el frontend evita esto pero defensiva).
 *
 *   4. `applySalePayment`: idempotencia + acreditación de cuenta receptora
 *      + INSERT SalePayment + FinancialMovement(INCOME, SALE).
 *
 *   5. Si hay SaleCredit:
 *        - `paid_amount += amount`, `balance -= amount`.
 *        - Status `PAID` si balance llega a 0; sino `PARTIALLY_PAID`.
 *      Y se acredita `Customer.balance += amount` (la deuda del cliente se
 *      reduce; signed → menos negativo).
 *
 *   6. Si llegó uuid ya procesado, la action devuelve `idempotent = true`
 *      con el payment existente y NO toca nada más.
 *
 * Si CUALQUIER paso falla → rollback total.
 */
@Injectable()
export class RegisterSalePaymentAction {
  private readonly logger = new Logger(RegisterSalePaymentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    saleId: number,
    dto: CreateSalePaymentDto,
    companyId: number,
    actor: SalePaymentActor,
  ): Promise<RegisterSalePaymentResult> {
    const amountBig: Big = toBig(dto.amount);
    if (amountBig.lte(0)) {
      throw new UnprocessableEntityException('El monto del cobro debe ser mayor a cero');
    }

    return this.dataSource.transaction<RegisterSalePaymentResult>(async (manager) => {
      // 1. Lock de la venta. requireActive lleva implícito is_deleted = false.
      const sale = await loadSaleForUpdate(manager, saleId, companyId);

      // 2. Credit con lock (si existe).
      const credit = await findSaleCredit(manager, saleId, companyId, { lock: true });

      // 3. Validar saldo.
      if (credit) {
        const balance = toBig(credit.balance);
        if (balance.lte(0)) {
          throw new UnprocessableEntityException('La venta ya está completamente pagada');
        }
        if (amountBig.gt(balance)) {
          throw new UnprocessableEntityException(
            `El monto excede el saldo pendiente (${balance.toFixed(2)})`,
          );
        }
      } else {
        // Venta sin credit: ya está pagada al 100%. Cualquier pago adicional
        // sería un sobrecobro.
        throw new UnprocessableEntityException(
          'La venta ya está completamente pagada (sin saldo pendiente)',
        );
      }

      // 4. Aplicar el pago (idempotente + acreditar cuenta + financial movement).
      const result = await applySalePayment(manager, this.financialMovementsService, {
        saleId: Number(sale.id),
        companyId,
        ticketReference: sale.sale_number ?? sale.ticket_number,
        // CRIT-1 auditoría: propagar customer_id para que el FinancialMovement
        // satisfaga `chk_financial_movements_source_consistency` (source NOT
        // NULL ⇒ source_id NOT NULL).
        customerId: sale.customer_id === null ? null : Number(sale.customer_id),
        account_type: dto.account_type,
        account_id: dto.account_id,
        amount: dto.amount,
        change_amount: dto.change_amount,
        uuid: dto.uuid ?? null,
        actor,
      });

      if (result.idempotent) {
        const aggregate = await this.loadAggregate(manager, Number(sale.id), companyId);
        return { aggregate, payment: result.payment, idempotent: true };
      }

      // 5. Actualizar credit + customer.balance.
      const amount = preciseNumber(amountBig, 2);
      const newPaid = preciseNumber(toBig(credit.paid_amount).plus(amountBig), 2);
      const newBalance = preciseNumber(toBig(credit.balance).minus(amountBig), 2);
      const newStatus = newBalance === 0 ? SaleCreditStatus.PAID : SaleCreditStatus.PARTIALLY_PAID;

      await manager.update(
        SaleCredit,
        { id: credit.id, company_id: String(companyId) },
        {
          paid_amount: newPaid,
          balance: newBalance,
          status: newStatus,
        },
      );

      // Customer.balance += amount (la deuda del cliente se reduce —
      // balance signed: si era -100 y abona 30, queda en -70).
      await manager.increment(
        Customer,
        { id: credit.customer_id, company_id: String(companyId) },
        'balance',
        amount,
      );

      this.logger.log({
        event: 'sale.payment_registered',
        companyId,
        saleId: Number(sale.id),
        paymentId: Number(result.payment.id),
        accountType: dto.account_type,
        accountId: dto.account_id,
        amount,
        newBalance,
        newStatus,
        actorId: actor.id,
      });

      const aggregate = await this.loadAggregate(manager, Number(sale.id), companyId);
      return { aggregate, payment: result.payment, idempotent: false };
    });
  }

  private async loadAggregate(
    manager: EntityManager,
    saleId: number,
    companyId: number,
  ): Promise<SaleAggregate> {
    const sale = await manager.findOne(SaleInvoice, {
      where: { id: String(saleId), company_id: String(companyId) },
    });
    if (!sale) {
      throw new UnprocessableEntityException('Venta no encontrada tras aplicar pago');
    }
    const lines = await findSaleLines(manager, saleId, companyId);
    const payments = await findSalePayments(manager, saleId, companyId);
    const credit = await findSaleCredit(manager, saleId, companyId);
    return { sale, lines, payments, credit };
  }
}
