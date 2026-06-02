import { randomUUID } from 'node:crypto';

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import {
  CarrierCredit,
  CarrierCreditStatus,
} from '@/modules/carriers/entities/carrier-credit.entity';
import { CarrierPayment } from '@/modules/carrier-payments/entities/carrier-payment.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import {
  AccountReference,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import {
  adjustInventory,
  type InventoryLineItem,
} from '@/modules/products/internal/adjust-inventory.helper';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { ArchivePurchaseDto } from '../dto/archive-purchase.dto';
import type { PurchasePaymentSource } from '../dto/create-purchase-payment.dto';
import { PurchaseCredit, PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import { PurchaseLine } from '../entities/purchase-line.entity';
import { PurchasePayment } from '../entities/purchase-payment.entity';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import {
  findPurchaseCredit,
  findPurchaseInCompany,
  findPurchasePayments,
} from '../internal/purchase-lookups';
import {
  recalcCostFromLastActivePurchase,
  type SkippedChild,
} from '../internal/recalculate-product-costs.helper';
import { ProductCostHistoryEvent } from '@/modules/product-history/entities/product-cost-history.entity';

/**
 * Snapshot del actor — para `created_by`/`created_by_id` en los logs y
 * FinancialMovements del reembolso, y para resolver la caja `cash_register`
 * destino cuando el reembolso va a efectivo.
 */
export interface ArchivePurchaseActor {
  id: number;
  fullName: string;
  type: string | null;
}

/**
 * Archiva (soft-delete) una compra. Endpoint `PUT /purchases/:id/archive` —
 * paridad PlacePos `archivePurchase`.
 *
 * --------------------------------------------------------------------------
 * Flujo all-or-nothing dentro de una transacción SERIALIZABLE
 * --------------------------------------------------------------------------
 *
 *   1. Lock pesimista sobre la compra y su `CarrierCredit` (si existe).
 *   2. Si `status = RECEIVED`: revertir stock (DEDUCT del unit_qty agregado
 *      por producto). Si la reversión dejaría stock negativo y el actor
 *      activó `force_stock_adjustment`, el helper clampea a 0; sino lanza
 *      422.
 *   3. Si hay pagos a la compra (purchase_payments) o pagos al transportista
 *      (carrier_payments): exigir `refund_source_*`. Por cada pago original
 *      se acredita la cuenta destino + registra `FinancialMovement(INCOME,
 *      REFUND)` (o `CashRegisterLog(REFUND, IN)` cuando la caja destino es
 *      cash_register, para mantener cero "doble" auditoría).
 *   4. Decrementar `Supplier.accumulated_debt` por el `balance` vivo del
 *      `PurchaseCredit` (los pagos ya restaron del debt al registrarse).
 *      Marcar el credit como `PAID` con `balance=0` para sacarlo de
 *      reportes de deuda viva.
 *   5. Saldar el `CarrierCredit` (balance=0, status=PAID) si existe — la
 *      fila se conserva para auditoría.
 *   6. Marcar `purchase.is_deleted = true`.
 *
 * --------------------------------------------------------------------------
 * Reglas de seguridad
 * --------------------------------------------------------------------------
 *
 *   - Multi-tenant: TODA query filtra por `company_id`.
 *   - `force_stock_adjustment` solo para owner/superadmin (403 si no).
 *   - Si `refund_source_type='cash_register'` se ignora `refund_source_id`
 *     y se resuelve la caja del actor (paridad PlacePos: blindaje contra
 *     reembolso cross-cashier).
 */
@Injectable()
export class ArchivePurchaseAction {
  private readonly logger = new Logger(ArchivePurchaseAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    id: number,
    dto: ArchivePurchaseDto,
    companyId: number,
    actor: ArchivePurchaseActor,
  ): Promise<void> {
    const forceStockAdjustment = !!dto.force_stock_adjustment;
    if (forceStockAdjustment && actor.type !== 'owner' && actor.type !== 'superadmin') {
      throw new ForbiddenException({
        message: 'Solo el dueño puede forzar el ajuste de inventario.',
        payload: { code: 'OVERRIDE_NOT_ALLOWED' },
      });
    }

    await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const purchase = await findPurchaseInCompany(manager, id, companyId, {
        requireActive: true,
      });

      const credit = await findPurchaseCredit(manager, id, companyId);
      const payments = await findPurchasePayments(manager, id, companyId);

      // Lock pesimista sobre CarrierCredit para evitar carrera con un POST
      // /carrier-payments concurrente: el nuevo abono no se reembolsaría y
      // la deuda quedaría inconsistente.
      const carrierCredit = await manager
        .createQueryBuilder(CarrierCredit, 'cc')
        .setLock('pessimistic_write')
        .where('cc.purchase_id = :pid AND cc.company_id = :cid', {
          pid: purchase.id,
          cid: String(companyId),
        })
        .getOne();
      const carrierPayments = carrierCredit
        ? await manager.find(CarrierPayment, {
            where: {
              carrier_credit_id: carrierCredit.id,
              company_id: String(companyId),
            },
            order: { created_at: 'ASC' },
          })
        : [];

      const totalRefund = [
        ...payments.map((p) => toBig(p.amount)),
        ...carrierPayments.map((p) => toBig(p.amount)),
      ].reduce((acc, n) => acc.plus(n), toBig(0));

      // Validación de refund_source si hay reembolsos pendientes.
      if (totalRefund.gt(0)) {
        if (!dto.refund_source_type) {
          throw new UnprocessableEntityException({
            message: 'Debe seleccionarse el tipo de caja destino para el reembolso',
            payload: { code: 'MISSING_REFUND_SOURCE' },
          });
        }
        if (
          dto.refund_source_type !== 'cash_register' &&
          (!dto.refund_source_id || dto.refund_source_id <= 0)
        ) {
          throw new UnprocessableEntityException({
            message: 'Debe seleccionarse la caja destino para el reembolso',
            payload: { code: 'MISSING_REFUND_SOURCE' },
          });
        }
      }

      // Reversión de stock si la compra estaba RECEIVED.
      if (purchase.status === PurchaseStatus.RECEIVED) {
        const affectedProductIds = await this.revertStock(
          manager,
          companyId,
          purchase,
          forceStockAdjustment,
          actor,
        );

        // Tras revertir stock, el costo de cada producto afectado debe
        // recalcularse contra la última compra activa que lo contenga (esta
        // compra deja de existir como referencia de costo). El `stockBefore`
        // de la ponderación es el stock YA revertido que el helper lee de la
        // DB (lockProduct), por lo que NO se pasa stockBeforeOverride —
        // paridad exacta con placepos `archivePurchase`. Si no hay compra
        // previa activa, conserva el costo actual pero registra el evento.
        const skipped: SkippedChild[] = [];
        for (const productId of affectedProductIds) {
          await recalcCostFromLastActivePurchase({
            manager,
            companyId,
            productId,
            eventType: ProductCostHistoryEvent.ARCHIVE,
            currentPurchaseId: Number(purchase.id),
            actor: { id: actor.id, fullName: actor.fullName },
            skipped,
          });
        }
      }

      // Despachar reembolsos a la cuenta seleccionada. Uno por cada pago
      // original — así el rastro contable coincide con los movimientos
      // generados al pagar.
      if (totalRefund.gt(0) && dto.refund_source_type) {
        await this.dispatchRefunds(manager, companyId, actor, {
          sourceType: dto.refund_source_type,
          sourceId: dto.refund_source_id ?? null,
          purchaseNumber: purchase.purchase_number,
          purchasePayments: payments,
          carrierPayments,
        });
      }

      // Saldar PurchaseCredit y revertir accumulated_debt por el saldo vivo.
      // El crédito se "reduce" al monto efectivamente pagado: total_amount = paid_amount,
      // balance = 0. Preserva los CHECKs `paid_amount + balance = total_amount` y
      // `status=PAID requires balance=0 AND paid_amount=total_amount`.
      if (credit) {
        const remainingBalance = toBig(credit.balance);
        if (remainingBalance.gt(0)) {
          await manager.decrement(
            Supplier,
            { id: purchase.supplier_id, company_id: String(companyId) },
            'accumulated_debt',
            preciseNumber(remainingBalance, 2),
          );
        }
        const settledAmount = preciseNumber(toBig(credit.paid_amount), 2);
        if (settledAmount > 0) {
          await manager.update(
            PurchaseCredit,
            { id: credit.id, company_id: String(companyId) },
            {
              total_amount: settledAmount,
              balance: 0,
              status: PurchaseCreditStatus.PAID,
            },
          );
        } else {
          // No hubo pagos — eliminamos el crédito porque `total_amount > 0` es CHECK
          // duro y no podemos dejar la fila en 0. La trazabilidad del archivado
          // queda en la compra (is_deleted=true) y en los movimientos financieros.
          await manager.delete(PurchaseCredit, {
            id: credit.id,
            company_id: String(companyId),
          });
        }
      }

      // Saldar CarrierCredit (la fila se conserva como histórico vinculado).
      // Mismo principio: total = paid_amount, balance = 0. CarrierCredit admite
      // total=0 (CHECK `total >= 0`) así que aquí sí podemos dejar la fila.
      if (carrierCredit) {
        const settledCarrierAmount = preciseNumber(toBig(carrierCredit.paid_amount), 2);
        await manager.update(
          CarrierCredit,
          { id: carrierCredit.id, company_id: String(companyId) },
          {
            total: settledCarrierAmount,
            balance: 0,
            status: CarrierCreditStatus.PAID,
          },
        );
      }

      // Soft-delete final.
      await manager.update(
        Purchase,
        { id: purchase.id, company_id: String(companyId) },
        { is_deleted: true },
      );

      this.logger.log({
        event: 'purchase.archived',
        companyId,
        purchaseId: id,
        actorId: actor.id,
        revertedDebt: credit ? preciseNumber(toBig(credit.balance), 2) : 0,
        totalRefund: preciseNumber(totalRefund, 2),
        refundSourceType: dto.refund_source_type ?? null,
        refundSourceId: dto.refund_source_id ?? null,
        forceStockAdjustment,
      });
    });
  }

  /**
   * Revierte el stock que entró al recibir la compra. La recepción
   * (`mark-purchase-received`) sumó `unit_qty` DIRECTO al stock porque en
   * compras `unit_qty` ya está en la unidad mínima (el embalaje es solo
   * informativo). Aquí restamos esa misma cantidad agregando por producto.
   *
   * Pasamos `packaging_value: 1` en cada línea para neutralizar la
   * multiplicación que `adjustInventory` —pensado para ventas, donde la
   * cantidad llega en unidad de venta— aplicaría por defecto con el
   * `packaging_value` del producto. Sin esto, el archivado restaría
   * `unit_qty × packaging_value` y corromper el stock de productos con empaque.
   */
  private async revertStock(
    manager: EntityManager,
    companyId: number,
    purchase: Purchase,
    forceStockAdjustment: boolean,
    actor: ArchivePurchaseActor,
  ): Promise<number[]> {
    const lines = await manager.find(PurchaseLine, {
      where: { purchase_id: purchase.id, company_id: String(companyId) },
    });

    // Productos tocados por la compra (aunque su unit_qty sea 0) — el recálculo
    // de costo posterior debe registrar el evento para todos ellos.
    const affectedProductIds = Array.from(new Set(lines.map((l) => Number(l.product_id)))).sort(
      (a, b) => a - b,
    );

    const totals = new Map<number, Big>();
    for (const l of lines) {
      const productId = Number(l.product_id);
      const qty = toBig(l.unit_qty);
      if (qty.lte(0)) {
        continue;
      }
      const prev = totals.get(productId) ?? toBig(0);
      totals.set(productId, prev.plus(qty));
    }

    const deduct: InventoryLineItem[] = [];
    for (const [productId, qtyBig] of totals.entries()) {
      // packaging_value: 1 → unit_qty ya está en unidad mínima; no re-multiplicar.
      deduct.push({ item_id: productId, quantity: Number(qtyBig.toFixed(4)), packaging_value: 1 });
    }

    if (deduct.length === 0) {
      return affectedProductIds;
    }

    await adjustInventory(manager, companyId, deduct, 'DEDUCT', {
      reason: 'PURCHASE_ARCHIVE',
      referenceType: 'purchase',
      referenceId: Number(purchase.id),
      referenceCode: purchase.purchase_number,
      description: `Archivado de compra ${purchase.purchase_number}`,
      actorName: actor.fullName,
      actorUserId: actor.id,
      overrideStock: forceStockAdjustment,
    });

    return affectedProductIds;
  }

  /**
   * Aplica los reembolsos uno por uno: suma a la caja destino y crea su
   * movimiento contable. Un movimiento por abono original — así el rastro
   * coincide con los movimientos generados al pagar.
   */
  private async dispatchRefunds(
    manager: EntityManager,
    companyId: number,
    actor: ArchivePurchaseActor,
    params: {
      sourceType: PurchasePaymentSource;
      sourceId: number | null;
      purchaseNumber: string;
      purchasePayments: PurchasePayment[];
      carrierPayments: CarrierPayment[];
    },
  ): Promise<void> {
    // Resolver la cuenta destino UNA sola vez con lock pesimista. Para
    // cash_register, ignoramos sourceId y resolvemos la caja del actor
    // (paridad PlacePos blindaje cross-cashier).
    const target = await this.resolveRefundTarget(
      manager,
      companyId,
      actor,
      params.sourceType,
      params.sourceId,
    );

    const entries: Array<{ amount: Big; reference: string; description: string }> = [];

    for (const p of params.purchasePayments) {
      const amount = toBig(p.amount);
      if (amount.lte(0)) {
        continue;
      }
      entries.push({
        amount,
        reference: `PURCHASE-VOID-${params.purchaseNumber}-${p.payment_number}`,
        description: `Reembolso por archivado de compra ${params.purchaseNumber} - Abono ${p.payment_number}`,
      });
    }

    for (const cp of params.carrierPayments) {
      const amount = toBig(cp.amount);
      if (amount.lte(0)) {
        continue;
      }
      entries.push({
        amount,
        reference: `PURCHASE-VOID-${params.purchaseNumber}-CP-${cp.id}`,
        description: `Reembolso por archivado de compra ${params.purchaseNumber} - Abono a transportista CP-${cp.id}`,
      });
    }

    for (const entry of entries) {
      // Acreditar la cuenta destino.
      const newBalance = preciseNumber(toBig(target.balance).plus(entry.amount), 2);
      await this.setTargetBalance(manager, companyId, target, newBalance);
      target.balance = newBalance;

      // Registrar el movimiento contable.
      if (target.type === 'cash_register') {
        const log = manager.create(CashRegisterLog, {
          company_id: String(companyId),
          cash_register_id: String(target.id),
          type: CashRegisterLogType.REFUND,
          direction: 'IN',
          amount: preciseNumber(entry.amount, 2),
          affects_balance: true,
          description: entry.description,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        });
        await manager.save(CashRegisterLog, log);
      } else {
        const destinationAccountRef: AccountReference = target.type;
        await this.financialMovementsService.record(manager, {
          companyId,
          amount: preciseNumber(entry.amount, 2),
          movement_type: MovementType.INCOME,
          concept: MovementConcept.REFUND,
          description: entry.description,
          source_type: null,
          source_id: null,
          destination_type: destinationAccountRef,
          destination_id: target.id,
          reference_code: `${entry.reference}-${randomUUID()}`,
          created_by: actor.fullName,
          created_by_id: actor.id,
        });
      }
    }
  }

  private async resolveRefundTarget(
    manager: EntityManager,
    companyId: number,
    actor: ArchivePurchaseActor,
    type: PurchasePaymentSource,
    id: number | null,
  ): Promise<{ type: PurchasePaymentSource; id: number; balance: number }> {
    if (type === 'wallet') {
      if (!id) {
        throw new UnprocessableEntityException({
          message: 'Debe seleccionarse la caja destino para el reembolso',
          payload: { code: 'MISSING_REFUND_SOURCE' },
        });
      }
      const wallet = await manager.findOne(Wallet, {
        where: {
          id: String(id),
          company_id: String(companyId),
          is_archived: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Billetera de reembolso no encontrada');
      }
      return { type: 'wallet', id: Number(wallet.id), balance: Number(wallet.balance) };
    }
    if (type === 'bank') {
      if (!id) {
        throw new UnprocessableEntityException({
          message: 'Debe seleccionarse la caja destino para el reembolso',
          payload: { code: 'MISSING_REFUND_SOURCE' },
        });
      }
      const bank = await manager.findOne(Bank, {
        where: {
          id: String(id),
          company_id: String(companyId),
          is_archived: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!bank) {
        throw new NotFoundException('Banco de reembolso no encontrado');
      }
      return { type: 'bank', id: Number(bank.id), balance: Number(bank.balance) };
    }
    // cash_register: la caja del actor.
    const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
    return {
      type: 'cash_register',
      id: Number(register.id),
      balance: Number(register.balance),
    };
  }

  private async setTargetBalance(
    manager: EntityManager,
    companyId: number,
    target: { type: PurchasePaymentSource; id: number },
    newBalance: number,
  ): Promise<void> {
    if (target.type === 'wallet') {
      await manager.update(
        Wallet,
        { id: String(target.id), company_id: String(companyId) },
        { balance: newBalance },
      );
      return;
    }
    if (target.type === 'bank') {
      await manager.update(
        Bank,
        { id: String(target.id), company_id: String(companyId) },
        { balance: newBalance },
      );
      return;
    }
    await manager.update(
      CashRegister,
      { id: String(target.id), company_id: String(companyId) },
      { balance: newBalance },
    );
  }
}
