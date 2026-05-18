import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { randomUUID } from 'node:crypto';
import { DataSource, In, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product, ProductType } from '@/modules/products/entities/product.entity';
import {
  adjustInventory,
  type InventoryLineItem,
} from '@/modules/products/internal/adjust-inventory.helper';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { CreatePurchaseLineDto } from '../dto/create-purchase.dto';
import type { PurchasePaymentSource } from '../dto/create-purchase-payment.dto';
import type { UpdatePurchaseDto } from '../dto/update-purchase.dto';
import { PurchaseCredit, PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import { PurchaseLine } from '../entities/purchase-line.entity';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import { translatePurchaseConstraintError } from '../internal/constraint-errors';
import {
  findPurchaseCredit,
  findPurchaseLines,
  findPurchasePayments,
} from '../internal/purchase-lookups';
import type { PurchaseAggregate } from './find-purchase.action';

/**
 * Actor que ejecuta la edición. `type` se usa para validar overrides
 * (force_stock_adjustment requiere owner/superadmin).
 */
export interface UpdatePurchaseActor {
  id: number;
  fullName: string;
  type: string | null;
}

/**
 * Edita una compra. Espejo PlacePos `PUT /purchases/:id` (`editPurchase` en
 * `purchaseEditOperations.ts`) con las simplificaciones explicadas en el DTO
 * (sin carrier/transport/total_kilos hasta que el esquema cloud los modele).
 *
 * --------------------------------------------------------------------------
 * Transacción SERIALIZABLE
 * --------------------------------------------------------------------------
 *
 * El flujo combina lock pesimista sobre Purchase + PurchaseCredit con cambios
 * en Supplier.accumulated_debt, inventario (stub), Wallet/Bank/CashRegister
 * (reembolso de excedente). SERIALIZABLE protege contra anomalías de lectura
 * no-repetible cuando un POST /payments concurrente cambia el credit.balance
 * mientras la edición lo está reconciliando. Paridad CLAUDE.md §9.4.
 *
 * --------------------------------------------------------------------------
 * Pasos
 * --------------------------------------------------------------------------
 *
 *   1. Lock pessimistic_write sobre Purchase y su PurchaseCredit. Validar
 *      `is_deleted = false`.
 *   2. Validar productos/packagings de las nuevas líneas (todos de la
 *      company, activos, SIMPLE).
 *   3. Calcular delta de stock por producto (old vs new) — replace total de
 *      líneas. Si el purchase ya está RECEIVED, aplicar deltas via
 *      `adjustInventory` (stub mientras `Product.stock` no exista).
 *   4. DELETE líneas viejas + INSERT líneas nuevas (denormalizando
 *      supplier_id que NO cambia).
 *   5. Recalcular totales con Big.js. Rechazar `total <= 0` con 422.
 *   6. UPDATE Purchase (subtotal, iva_total, total, invoice_date,
 *      invoice_number).
 *   7. Reconciliar PurchaseCredit:
 *        - Si newTotal < paid_amount → reembolso del excedente a la cuenta
 *          indicada en `refund_source_*`. Crédito queda en PAID con balance=0.
 *        - Si newTotal >= paid_amount → ajustar total/balance/status.
 *        - Ajustar Supplier.accumulated_debt por el delta del balance vivo.
 *
 * --------------------------------------------------------------------------
 * supplier_id inmutable
 * --------------------------------------------------------------------------
 *
 * El DTO no acepta supplier_id. Cambiar de proveedor exige archivar la compra
 * y crear una nueva — paridad PlacePos. Las nuevas líneas reciben el mismo
 * `supplier_id` que la compra original (denormalización).
 */
@Injectable()
export class UpdatePurchaseAction {
  private readonly logger = new Logger(UpdatePurchaseAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    id: number,
    dto: UpdatePurchaseDto,
    companyId: number,
    actor: UpdatePurchaseActor,
  ): Promise<PurchaseAggregate> {
    return this.dataSource.transaction<PurchaseAggregate>('SERIALIZABLE', async (manager) =>
      this.run(manager, id, dto, companyId, actor),
    );
  }

  private async run(
    manager: EntityManager,
    id: number,
    dto: UpdatePurchaseDto,
    companyId: number,
    actor: UpdatePurchaseActor,
  ): Promise<PurchaseAggregate> {
    // 0. Enforcement early de `force_stock_adjustment`. Solo `owner |
    //    superadmin` pueden activar la flag — `manager`/`employee` reciben
    //    403 ANTES de cualquier mutación. Unificado con el resto del API
    //    bajo el código `OVERRIDE_NOT_ALLOWED` para que el frontend ramifique
    //    una sola vez.
    const forceStockAdjustment = !!dto.force_stock_adjustment;
    if (forceStockAdjustment && actor.type !== 'owner' && actor.type !== 'superadmin') {
      throw new ForbiddenException({
        message: 'Solo el dueño puede forzar el ajuste de inventario.',
        payload: { code: 'OVERRIDE_NOT_ALLOWED' },
      });
    }

    // 1. Validar fecha legible.
    const invoiceDate = new Date(dto.invoice_date);
    if (Number.isNaN(invoiceDate.getTime())) {
      throw new BadRequestException('Fecha de factura inválida');
    }
    const invoiceNumber = dto.invoice_number?.trim() ? dto.invoice_number.trim() : null;

    // 2. Lock + lectura de la compra.
    const purchase = await manager
      .createQueryBuilder(Purchase, 'p')
      .setLock('pessimistic_write')
      .where('p.id = :id AND p.company_id = :companyId', {
        id: String(id),
        companyId: String(companyId),
      })
      .getOne();
    if (!purchase) {
      throw new NotFoundException('Compra no encontrada');
    }
    if (purchase.is_deleted) {
      throw new UnprocessableEntityException({
        message: 'Compra archivada, no editable',
        payload: { code: 'PURCHASE_ARCHIVED' },
      });
    }

    // Lock del credit en simultáneo: un POST /payments concurrente queda
    // serializado en el lock.
    const credit = await manager
      .createQueryBuilder(PurchaseCredit, 'pc')
      .setLock('pessimistic_write')
      .where('pc.purchase_id = :id AND pc.company_id = :companyId', {
        id: String(purchase.id),
        companyId: String(companyId),
      })
      .getOne();

    // 3. Validar productos/packagings de las nuevas líneas.
    const { productById, packagingById } = await this.validateRefs(manager, dto.lines, companyId);

    // 4. Leer líneas viejas para delta de stock.
    const oldLines = await manager.find(PurchaseLine, {
      where: {
        purchase_id: String(purchase.id),
        company_id: String(companyId),
      },
    });

    // 5. Replace líneas: DELETE + INSERT.
    await manager.delete(PurchaseLine, {
      purchase_id: String(purchase.id),
      company_id: String(companyId),
    });

    // 6. Calcular totales y construir las nuevas filas con Big.js.
    let totalSubtotal: Big = toBig(0);
    let totalIva: Big = toBig(0);
    let totalGrand: Big = toBig(0);

    const linesData = dto.lines.map((line: CreatePurchaseLineDto) => {
      const product = productById.get(line.product_id);
      if (!product) {
        // Defensa: ya validado arriba, este branch nunca debería ejecutarse.
        throw new BadRequestException('Uno o más productos no existen');
      }

      const packagingQty = toBig(line.packaging_qty ?? 0);
      const packagingPrice = toBig(line.packaging_price ?? 0);
      const ivaRate = toBig(line.iva_rate ?? 0);

      const subtotal = packagingQty.times(packagingPrice);
      const ivaAmount = subtotal.times(ivaRate).div(100);
      const lineTotal = subtotal.plus(ivaAmount);

      if (subtotal.lte(0)) {
        throw new UnprocessableEntityException(
          `La línea "${product.name}" tiene un subtotal en cero. Verifica cantidad y precio.`,
        );
      }

      totalSubtotal = totalSubtotal.plus(subtotal);
      totalIva = totalIva.plus(ivaAmount);
      totalGrand = totalGrand.plus(lineTotal);

      let packagingId: string | null = null;
      let packagingName: string | null = line.packaging_name ?? null;
      let packagingValue: number | null =
        line.packaging_value === null || line.packaging_value === undefined
          ? null
          : preciseNumber(toBig(line.packaging_value), 4);

      if (typeof line.packaging_id === 'number' && line.packaging_id > 0) {
        const packaging = packagingById.get(line.packaging_id);
        if (!packaging) {
          throw new BadRequestException('Uno o más empaques no existen o están archivados');
        }
        packagingId = String(packaging.id);
        packagingName = packagingName ?? packaging.name;
        if (packagingValue === null) {
          packagingValue = preciseNumber(toBig(packaging.value), 4);
        }
      } else if (product.packaging_id !== null && product.packaging_id !== undefined) {
        packagingId = product.packaging_id;
      }

      return {
        company_id: String(companyId),
        purchase_id: purchase.id,
        product_id: String(product.id),
        supplier_id: String(purchase.supplier_id),
        name: line.name?.trim() || product.name,
        packaging_id: packagingId,
        packaging_name: packagingName,
        packaging_value: packagingValue,
        packaging_qty: preciseNumber(packagingQty, 4),
        unit_qty: preciseNumber(toBig(line.unit_qty ?? 0), 4),
        unit_price: preciseNumber(toBig(line.unit_price ?? 0), 4),
        packaging_price: preciseNumber(packagingPrice, 2),
        iva_rate: preciseNumber(ivaRate, 2),
        subtotal: preciseNumber(subtotal, 2),
        iva_amount: preciseNumber(ivaAmount, 2),
        total: preciseNumber(lineTotal, 2),
      };
    });

    if (totalGrand.lte(0)) {
      throw new UnprocessableEntityException('El total de la compra debe ser mayor a cero');
    }

    await manager.insert(PurchaseLine, linesData);

    // 7. Ajuste de inventario diferencial solo si la compra está RECEIVED.
    if (purchase.status === PurchaseStatus.RECEIVED) {
      await this.applyInventoryDelta(manager, companyId, oldLines, linesData);
    }

    // 8. UPDATE Purchase con nuevos totales + invoice metadata.
    const totalRounded = preciseNumber(totalGrand, 2);
    try {
      await manager.update(
        Purchase,
        { id: purchase.id, company_id: String(companyId) },
        {
          subtotal: preciseNumber(totalSubtotal, 2),
          iva_total: preciseNumber(totalIva, 2),
          total: totalRounded,
          invoice_date: invoiceDate,
          invoice_number: invoiceNumber,
        },
      );
    } catch (error) {
      translatePurchaseConstraintError(error);
      throw error;
    }

    // 9. Reconciliar PurchaseCredit + Supplier.accumulated_debt.
    if (credit) {
      await this.reconcileCredit(
        manager,
        companyId,
        purchase,
        credit,
        toBig(totalRounded),
        dto.refund_source_type ?? null,
        dto.refund_source_id ?? null,
        actor,
      );
    }

    this.logger.log({
      event: 'purchase.updated',
      companyId,
      purchaseId: Number(purchase.id),
      purchaseNumber: purchase.purchase_number,
      newTotal: totalRounded,
      lineCount: linesData.length,
      forceStockAdjustment,
      actorId: actor.id,
    });

    // 10. Releer aggregate.
    const refreshed = await manager.findOne(Purchase, {
      where: { id: purchase.id, company_id: String(companyId) },
    });
    if (!refreshed) {
      // Defensa: si el UPDATE ya completó y la fila no se relee, hubo un
      // borrado concurrente — pero la transacción ya cometería. Imposible en
      // la práctica; lanzamos para no devolver datos inconsistentes.
      throw new NotFoundException('Compra no encontrada tras la edición');
    }
    const lines = await findPurchaseLines(manager, Number(purchase.id), companyId);
    const creditOut = await findPurchaseCredit(manager, Number(purchase.id), companyId);
    const payments = await findPurchasePayments(manager, Number(purchase.id), companyId);
    return { purchase: refreshed, lines, credit: creditOut, payments };
  }

  /**
   * Valida productos y packagings de las nuevas líneas, filtrando por company.
   * Devuelve mapas indexados por id para la fase de construcción de filas.
   */
  private async validateRefs(
    manager: EntityManager,
    lines: CreatePurchaseLineDto[],
    companyId: number,
  ): Promise<{
    productById: Map<number, Product>;
    packagingById: Map<number, Packaging>;
  }> {
    const productIds = Array.from(new Set(lines.map((l) => String(l.product_id))));
    const products = await manager.find(Product, {
      where: { id: In(productIds), company_id: String(companyId) },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException('Uno o más productos no existen');
    }
    const invalidProduct = products.find(
      (p) => p.product_type !== ProductType.SIMPLE || p.is_archived,
    );
    if (invalidProduct) {
      throw new BadRequestException(
        `El producto "${invalidProduct.name}" no es un producto simple disponible`,
      );
    }
    const productById = new Map<number, Product>(products.map((p) => [Number(p.id), p]));

    const packagingIds = Array.from(
      new Set(
        lines
          .map((l) => l.packaging_id)
          .filter((id): id is number => typeof id === 'number' && id > 0)
          .map((id) => String(id)),
      ),
    );
    const packagingById = new Map<number, Packaging>();
    if (packagingIds.length > 0) {
      const packagings = await manager.find(Packaging, {
        where: {
          id: In(packagingIds),
          company_id: String(companyId),
          is_archived: false,
        },
      });
      if (packagings.length !== packagingIds.length) {
        throw new BadRequestException('Uno o más empaques no existen o están archivados');
      }
      for (const p of packagings) {
        packagingById.set(Number(p.id), p);
      }
    }
    return { productById, packagingById };
  }

  /**
   * Aplica el delta de stock al inventario via `adjustInventory` (STUB hasta
   * que `Product.stock` exista en el esquema). Cada línea aporta
   * `unit_qty × packaging_value` al stock del padre. Aquí componemos las
   * "líneas equivalentes" en cantidad neta (positiva = RETURN, negativa =
   * DEDUCT).
   *
   * Implementación segura mientras el helper es STUB: el cálculo del delta
   * funciona contra los datos persistidos; cuando `Product.stock` aterrice,
   * el helper aplicará el UPDATE real sin que la action cambie.
   */
  private async applyInventoryDelta(
    manager: EntityManager,
    companyId: number,
    oldLines: PurchaseLine[],
    newLinesData: Array<{ product_id: string; unit_qty: number }>,
  ): Promise<void> {
    const totals = new Map<number, Big>();
    // OUT (vieja contribución): sumamos lo que la compra anterior aportó al
    // inventario.
    for (const l of oldLines) {
      const productId = Number(l.product_id);
      const qty = toBig(l.unit_qty);
      const prev = totals.get(productId) ?? toBig(0);
      totals.set(productId, prev.minus(qty)); // negativa → contribución vieja
    }
    // IN (nueva contribución): lo que la compra editada aportará.
    for (const l of newLinesData) {
      const productId = Number(l.product_id);
      const qty = toBig(l.unit_qty);
      const prev = totals.get(productId) ?? toBig(0);
      totals.set(productId, prev.plus(qty));
    }

    const deduct: InventoryLineItem[] = [];
    const ret: InventoryLineItem[] = [];
    for (const [productId, deltaBig] of totals.entries()) {
      if (deltaBig.eq(0)) {
        continue;
      }
      if (deltaBig.gt(0)) {
        ret.push({ item_id: productId, quantity: Number(deltaBig.toFixed(4)) });
      } else {
        deduct.push({ item_id: productId, quantity: Number(deltaBig.abs().toFixed(4)) });
      }
    }
    if (ret.length > 0) {
      await adjustInventory(manager, companyId, ret, 'RETURN');
    }
    if (deduct.length > 0) {
      await adjustInventory(manager, companyId, deduct, 'DEDUCT');
    }
  }

  /**
   * Reconcilia PurchaseCredit + Supplier.accumulated_debt tras un cambio de
   * total. Dos escenarios:
   *
   *   - **newTotal < paid_amount**: reembolso del excedente al proveedor
   *     usando la cuenta indicada en `refund_source_*`. El crédito queda en
   *     PAID con balance=0 y `paid_amount = newTotal` (PlacePos hace lo mismo
   *     — el dinero ya pagado nunca se "descobra"; el cliente recibe el
   *     reembolso). El supplier.accumulated_debt se decrementa por el
   *     `previousBalance` solamente.
   *
   *   - **newTotal >= paid_amount**: ajustar `total_amount` + `balance` +
   *     `status`. El supplier.accumulated_debt se ajusta por el delta del
   *     balance vivo (`newBalance - previousBalance`).
   */
  private async reconcileCredit(
    manager: EntityManager,
    companyId: number,
    purchase: Purchase,
    credit: PurchaseCredit,
    newTotal: Big,
    refundSourceType: PurchasePaymentSource | null,
    refundSourceId: number | null,
    actor: UpdatePurchaseActor,
  ): Promise<void> {
    const paid = toBig(credit.paid_amount);
    const previousBalance = toBig(credit.balance);
    const newTotalRounded = preciseNumber(newTotal, 2);

    if (newTotal.lt(paid)) {
      // Reembolso del excedente.
      const excess = paid.minus(newTotal);
      await this.refundExcess(
        manager,
        companyId,
        purchase,
        refundSourceType,
        refundSourceId,
        excess,
        actor,
        'Reembolso por edición de compra',
      );

      await manager.update(
        PurchaseCredit,
        { id: credit.id, company_id: String(companyId) },
        {
          total_amount: newTotalRounded,
          paid_amount: newTotalRounded,
          balance: 0,
          status: PurchaseCreditStatus.PAID,
        },
      );

      if (previousBalance.gt(0)) {
        await manager.decrement(
          Supplier,
          { id: purchase.supplier_id, company_id: String(companyId) },
          'accumulated_debt',
          preciseNumber(previousBalance, 2),
        );
      }
      return;
    }

    // newTotal >= paid → ajustar balance/status.
    const newBalance = newTotal.minus(paid);
    const newBalanceRounded = preciseNumber(newBalance, 2);
    const newStatus = newBalance.lte(0)
      ? PurchaseCreditStatus.PAID
      : paid.gt(0)
        ? PurchaseCreditStatus.PARTIALLY_PAID
        : PurchaseCreditStatus.PENDING;

    await manager.update(
      PurchaseCredit,
      { id: credit.id, company_id: String(companyId) },
      {
        total_amount: newTotalRounded,
        balance: newBalanceRounded,
        status: newStatus,
      },
    );

    const debtDelta = newBalance.minus(previousBalance);
    if (debtDelta.gt(0)) {
      await manager.increment(
        Supplier,
        { id: purchase.supplier_id, company_id: String(companyId) },
        'accumulated_debt',
        preciseNumber(debtDelta, 2),
      );
    } else if (debtDelta.lt(0)) {
      await manager.decrement(
        Supplier,
        { id: purchase.supplier_id, company_id: String(companyId) },
        'accumulated_debt',
        preciseNumber(debtDelta.abs(), 2),
      );
    }
  }

  /**
   * Reembolso de excedente al cliente cuando newTotal < paid_amount. La caja
   * de destino se valida según `refund_source_type`:
   *   - `wallet` / `bank`: id de la company, no archivada, balance += excess.
   *   - `cash_register`: se resuelve la caja del actor con lock (NO se acepta
   *     `refund_source_id` para CASH — paridad PlacePos: `getOrCreateCashRegisterForUser`).
   *
   * Side effects:
   *   - wallet/bank: INSERT FinancialMovement (INCOME, ADJUSTMENT) con
   *     `destination_type/destination_id = cuenta destino`.
   *   - cash_register: INSERT CashRegisterLog (REFUND, IN, affects=true).
   */
  private async refundExcess(
    manager: EntityManager,
    companyId: number,
    purchase: Purchase,
    sourceType: PurchasePaymentSource | null,
    sourceId: number | null,
    excess: Big,
    actor: UpdatePurchaseActor,
    description: string,
  ): Promise<void> {
    if (excess.lte(0)) {
      return;
    }

    if (!sourceType) {
      throw new UnprocessableEntityException({
        message: 'Debe seleccionarse la caja destino para el reembolso del proveedor',
        payload: { code: 'MISSING_REFUND_SOURCE' },
      });
    }
    if (sourceType !== 'cash_register' && (!sourceId || sourceId <= 0)) {
      throw new UnprocessableEntityException({
        message: 'Debe seleccionarse la caja destino para el reembolso del proveedor',
        payload: { code: 'MISSING_REFUND_SOURCE' },
      });
    }

    const excessRounded = preciseNumber(excess, 2);
    const fullDescription = `${description} ${purchase.purchase_number}`;

    if (sourceType === 'wallet') {
      // Para wallet/bank el sourceId no puede ser null en este punto (la
      // guarda anterior lo garantizó). Lo capturamos en una const con
      // narrowing explícito para no recurrir a `!`.
      if (sourceId === null || sourceId === undefined) {
        throw new UnprocessableEntityException({
          message: 'Debe seleccionarse la caja destino para el reembolso del proveedor',
          payload: { code: 'MISSING_REFUND_SOURCE' },
        });
      }
      const walletId = sourceId;
      const wallet = await manager.findOne(Wallet, {
        where: {
          id: String(walletId),
          company_id: String(companyId),
          is_archived: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Billetera de reembolso no encontrada');
      }
      const newBalance = preciseNumber(toBig(wallet.balance).plus(excess), 2);
      await manager.update(
        Wallet,
        { id: wallet.id, company_id: String(companyId) },
        { balance: newBalance },
      );
      await this.financialMovementsService.record(manager, {
        companyId,
        amount: excessRounded,
        movement_type: MovementType.INCOME,
        concept: MovementConcept.ADJUSTMENT,
        description: fullDescription,
        source_type: null,
        source_id: null,
        destination_type: 'wallet',
        destination_id: Number(wallet.id),
        reference_code: `REF-${randomUUID()}`,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
      return;
    }

    if (sourceType === 'bank') {
      if (sourceId === null || sourceId === undefined) {
        throw new UnprocessableEntityException({
          message: 'Debe seleccionarse la caja destino para el reembolso del proveedor',
          payload: { code: 'MISSING_REFUND_SOURCE' },
        });
      }
      const bankId = sourceId;
      const bank = await manager.findOne(Bank, {
        where: {
          id: String(bankId),
          company_id: String(companyId),
          is_archived: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!bank) {
        throw new NotFoundException('Banco de reembolso no encontrado');
      }
      const newBalance = preciseNumber(toBig(bank.balance).plus(excess), 2);
      await manager.update(
        Bank,
        { id: bank.id, company_id: String(companyId) },
        { balance: newBalance },
      );
      await this.financialMovementsService.record(manager, {
        companyId,
        amount: excessRounded,
        movement_type: MovementType.INCOME,
        concept: MovementConcept.ADJUSTMENT,
        description: fullDescription,
        source_type: null,
        source_id: null,
        destination_type: 'bank',
        destination_id: Number(bank.id),
        reference_code: `REF-${randomUUID()}`,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
      return;
    }

    // sourceType === 'cash_register'. La caja del actor se resuelve por user_id.
    const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
    const newBalance = preciseNumber(toBig(register.balance).plus(excess), 2);
    await manager.update(
      CashRegister,
      { id: register.id, company_id: String(companyId) },
      { balance: newBalance },
    );
    const log = manager.create(CashRegisterLog, {
      company_id: String(companyId),
      cash_register_id: register.id,
      type: CashRegisterLogType.REFUND,
      direction: 'IN',
      amount: excessRounded,
      affects_balance: true,
      description: fullDescription,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
    await manager.save(CashRegisterLog, log);
  }
}
