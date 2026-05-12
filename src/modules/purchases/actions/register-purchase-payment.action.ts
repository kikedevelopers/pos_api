import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { randomUUID } from 'node:crypto';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { requireOpenCashRegisterForUpdate } from '@/modules/cash-register/internal/cash-register-lookups';
import { computeCashRegisterBalance } from '@/modules/cash-register/internal/compute-balance';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type {
  CreatePurchasePaymentDto,
  PurchasePaymentSource,
} from '../dto/create-purchase-payment.dto';
import { PurchaseCredit, PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import { PurchasePayment, PurchasePaymentMethod } from '../entities/purchase-payment.entity';
import {
  isPurchasePaymentUuidConflict,
  translatePurchaseConstraintError,
} from '../internal/constraint-errors';
import {
  findPurchaseCredit,
  findPurchaseInCompany,
  findPurchaseLines,
  findPurchasePayments,
} from '../internal/purchase-lookups';
import { nextPaymentNumber } from '../internal/purchase-number';
import type { PurchaseAggregate } from './find-purchase.action';

/**
 * Actor que registra el pago (snapshot guardado en `created_by`/`created_by_id`).
 */
export interface PurchasePaymentActor {
  id: number;
  fullName: string;
}

/**
 * Resultado del registro. Incluye un flag `idempotent` para que el controller
 * pueda responder con el status apropiado:
 *   - Nuevo pago: 201.
 *   - Pago ya procesado (uuid existente): 200.
 *
 * Espejo de comportamiento PlacePos pero con semántica HTTP explícita.
 */
export interface RegisterPurchasePaymentResult {
  aggregate: PurchaseAggregate;
  payment: PurchasePayment;
  idempotent: boolean;
}

/**
 * Datos resueltos de la cuenta origen tras validar tenancy y saldo.
 */
interface ResolvedSource {
  /** Nombre legible para descripciones del movement. */
  name: string;
  /** Bank.id si TRANSFER, o null para CASH. */
  bankId: number | null;
  /** Snapshot del nombre de banco si aplica. */
  bankName: string | null;
  /** Método PlacePos: TRANSFER si bank, CASH si wallet/cash_register. */
  paymentMethod: PurchasePaymentMethod;
}

/**
 * Registra un abono a una compra. Espejo de `POST /purchases/:id/payments`
 * de PlacePos pero refactorizado dentro de UNA transacción NestJS.
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos
 * --------------------------------------------------------------------------
 *
 *   1. **Idempotencia fast-path.** Si el DTO trae `uuid` y ya existe un
 *      `purchase_payment` con `(company_id, uuid)`, devuelve ese row sin
 *      reprocesar. HTTP 200 (no 201).
 *
 *   2. Carga la compra (`is_deleted = false`) y su credit. Si no hay credit
 *      → estado inconsistente (no debería suceder; el create siempre
 *      genera uno). Si `credit.balance = 0` → 422 (compra ya pagada).
 *
 *   3. Validar saldo solicitado <= balance pendiente. Sobrepago rechazado
 *      con mensaje legible.
 *
 *   4. Resolver `source_type` + `source_id` dentro de la company:
 *        - `bank`: cuenta bancaria activa. Verifica `balance >= amount`.
 *          Decrementa `Bank.balance` con UPDATE. `payment_method = TRANSFER`.
 *        - `wallet`: billetera activa. Verifica balance. Decrementa.
 *          `payment_method = CASH`.
 *        - `cash_register`: turno abierto de la company. Calcula balance
 *          corriente con `GetCashRegisterBalanceAction`. Inserta
 *          `CashRegisterLog(direction = OUT, type = CASH_OUT)` para
 *          restar del expected. `payment_method = CASH`.
 *
 *   5. INSERT `PurchasePayment` con `payment_number` generado por advisory
 *      lock (mismo patrón que `purchase_number`).
 *
 *   6. INSERT `FinancialMovement(EXPENSE, concept = PURCHASE)` con
 *      `source_type/source_id = cuenta`, `destination_type = 'external'`
 *      (el supplier), `description` legible.
 *
 *   7. UPDATE `PurchaseCredit`:
 *        - `paid_amount += amount`
 *        - `balance     -= amount`
 *        - `status = PAID` si balance llega a 0, sino `PARTIALLY_PAID`.
 *
 *   8. Decrementar `Supplier.accumulated_debt` por `amount` (espejo PlacePos).
 *
 * Si CUALQUIER paso falla → rollback total. La invariante contable del
 * `PurchaseCredit` (CHECK `paid + balance = total`) blinda en DB.
 *
 * --------------------------------------------------------------------------
 * Race-condition uuid (defensa final)
 * --------------------------------------------------------------------------
 *
 * Dos requests concurrentes con el mismo uuid pueden pasar el fast-path
 * (ambos leen "no existe") y simultáneamente intentar INSERT. El UNIQUE
 * parcial `(company_id, uuid) WHERE uuid IS NOT NULL` rechaza al perdedor
 * con SQLSTATE 23505. Detectamos eso por `isPurchasePaymentUuidConflict` y
 * relee el row del ganador, devolviendo 200.
 */
@Injectable()
export class RegisterPurchasePaymentAction {
  private readonly logger = new Logger(RegisterPurchasePaymentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    purchaseId: number,
    dto: CreatePurchasePaymentDto,
    companyId: number,
    actor: PurchasePaymentActor,
  ): Promise<RegisterPurchasePaymentResult> {
    const idempotencyKey = dto.uuid ?? randomUUID();
    const amountBig: Big = toBig(dto.amount);
    if (amountBig.lte(0)) {
      throw new UnprocessableEntityException('El monto del abono debe ser mayor a cero');
    }
    const amount = preciseNumber(amountBig, 2);

    return this.dataSource.transaction<RegisterPurchasePaymentResult>(async (manager) => {
      // 1. Pre-validar compra activa ANTES del fast-path (HIGH-5 auditoría).
      //    Sin esto, un fast-path sobre una compra ya anulada (is_deleted=true)
      //    devolvería el pago "anterior" con 200, dando la falsa impresión al
      //    cliente de que se aplicó un nuevo abono a una compra inválida.
      const purchase = await findPurchaseInCompany(manager, purchaseId, companyId, {
        requireActive: true,
      });

      // 2. Fast-path idempotencia.
      const existing = await manager.findOne(PurchasePayment, {
        where: { company_id: String(companyId), uuid: idempotencyKey },
      });
      if (existing) {
        if (Number(existing.purchase_id) !== purchaseId) {
          // El uuid ya se usó para OTRA compra. Defensa anti-cross-purchase.
          throw new UnprocessableEntityException('El uuid ya fue utilizado para otra compra');
        }
        const aggregate = await this.loadAggregate(manager, purchaseId, companyId);
        return { aggregate, payment: existing, idempotent: true };
      }

      // 3. Cargar credit (la compra ya fue validada en paso 1).
      const credit = await findPurchaseCredit(manager, purchaseId, companyId);
      if (!credit) {
        throw new UnprocessableEntityException(
          'La compra no tiene un crédito asociado para registrar abonos',
        );
      }
      const currentBalance = toBig(credit.balance);
      if (currentBalance.lte(0)) {
        throw new UnprocessableEntityException('La compra ya está completamente pagada');
      }
      if (amountBig.gt(currentBalance)) {
        throw new UnprocessableEntityException(
          `El monto excede el saldo pendiente (${currentBalance.toFixed(2)})`,
        );
      }

      // 3. Resolver y debitar la fuente.
      const source = await this.debitSource(
        manager,
        dto.source_type,
        dto.source_id,
        companyId,
        amountBig,
        actor,
      );

      // 4. INSERT PurchasePayment con folio per-company.
      const paymentNumber = await nextPaymentNumber(manager, companyId);
      const paymentEntity = manager.create(PurchasePayment, {
        company_id: String(companyId),
        purchase_id: purchase.id,
        payment_number: paymentNumber,
        payment_method: source.paymentMethod,
        amount,
        bank_id: source.bankId === null ? null : String(source.bankId),
        bank_name: source.bankName,
        source_type: dto.source_type,
        source_id: String(dto.source_id),
        notes: dto.notes ?? null,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
        uuid: idempotencyKey,
      });

      let savedPayment: PurchasePayment;
      try {
        savedPayment = await manager.save(PurchasePayment, paymentEntity);
      } catch (error) {
        // Race-condition: otra request con el mismo uuid ganó. Releer ganador.
        if (isPurchasePaymentUuidConflict(error)) {
          const winner = await manager.findOne(PurchasePayment, {
            where: { company_id: String(companyId), uuid: idempotencyKey },
          });
          if (!winner) {
            throw error;
          }
          const aggregate = await this.loadAggregate(manager, purchaseId, companyId);
          return { aggregate, payment: winner, idempotent: true };
        }
        translatePurchaseConstraintError(error);
        throw error;
      }

      // 5. FinancialMovement (EXPENSE, PURCHASE) atribuido al supplier.
      await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.PURCHASE,
        description: `Abono a compra ${purchase.purchase_number} (${purchase.supplier_name})`,
        source_type: dto.source_type,
        source_id: dto.source_id,
        destination_type: 'external',
        destination_id: Number(purchase.supplier_id),
        reference_code: `PAY-${paymentNumber}`,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      // 6. Actualizar PurchaseCredit (paid_amount, balance, status).
      const newPaid = preciseNumber(toBig(credit.paid_amount).plus(amountBig), 2);
      const newBalanceBig = currentBalance.minus(amountBig);
      const newBalance = preciseNumber(newBalanceBig, 2);
      // HIGH-3 auditoría: `toBig().lte(0)` en lugar de `=== 0` para alinear con
      // la comparación de línea 186 (`currentBalance.lte(0)`) y tolerar
      // valores residuales de coerción numérica (-0, 0.00001 por bug futuro).
      const newStatus = newBalanceBig.lte(0)
        ? PurchaseCreditStatus.PAID
        : PurchaseCreditStatus.PARTIALLY_PAID;
      await manager.update(
        PurchaseCredit,
        { id: credit.id, company_id: String(companyId) },
        {
          paid_amount: newPaid,
          balance: newBalance,
          status: newStatus,
        },
      );

      // 7. Decrementar deuda acumulada del proveedor.
      await manager.decrement(
        Supplier,
        { id: purchase.supplier_id, company_id: String(companyId) },
        'accumulated_debt',
        amount,
      );

      this.logger.log({
        event: 'purchase.payment_registered',
        companyId,
        purchaseId,
        paymentId: Number(savedPayment.id),
        paymentNumber,
        sourceType: dto.source_type,
        sourceId: dto.source_id,
        amount,
        newBalance,
        newStatus,
        actorId: actor.id,
      });

      const aggregate = await this.loadAggregate(manager, purchaseId, companyId);
      return { aggregate, payment: savedPayment, idempotent: false };
    });
  }

  /**
   * Resuelve la fuente (wallet/bank/cash_register), valida saldo y la debita.
   * Devuelve los datos necesarios para serializar el PurchasePayment.
   */
  private async debitSource(
    manager: EntityManager,
    sourceType: PurchasePaymentSource,
    sourceId: number,
    companyId: number,
    amountBig: Big,
    actor: PurchasePaymentActor,
  ): Promise<ResolvedSource> {
    const amount = preciseNumber(amountBig, 2);

    if (sourceType === 'bank') {
      // CRIT-2 auditoría: `lock: pessimistic_write` serializa lecturas
      // concurrentes del mismo row de Bank dentro de transacciones distintas.
      // Sin lock, dos pagos concurrentes desde el mismo banco con balance=100
      // podían validar ambos `100>=60` y dejar el balance en 40 (lost update).
      const bank = await manager.findOne(Bank, {
        where: {
          id: String(sourceId),
          company_id: String(companyId),
          is_archived: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!bank) {
        throw new NotFoundException('Cuenta bancaria no encontrada');
      }
      const balance = toBig(bank.balance);
      if (amountBig.gt(balance)) {
        throw new UnprocessableEntityException(
          `Saldo insuficiente en banco. Disponible: ${balance.toFixed(2)}`,
        );
      }
      const newBalance = preciseNumber(balance.minus(amountBig), 2);
      await manager.update(
        Bank,
        { id: bank.id, company_id: String(companyId) },
        { balance: newBalance },
      );
      return {
        name: bank.name,
        bankId: Number(bank.id),
        bankName: bank.name,
        paymentMethod: PurchasePaymentMethod.TRANSFER,
      };
    }

    if (sourceType === 'wallet') {
      // CRIT-2 auditoría: idem bank — lock pessimistic_write para evitar
      // lost-update de balance.
      const wallet = await manager.findOne(Wallet, {
        where: {
          id: String(sourceId),
          company_id: String(companyId),
          is_archived: false,
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Billetera no encontrada');
      }
      const balance = toBig(wallet.balance);
      if (amountBig.gt(balance)) {
        throw new UnprocessableEntityException(
          `Saldo insuficiente en billetera. Disponible: ${balance.toFixed(2)}`,
        );
      }
      const newBalance = preciseNumber(balance.minus(amountBig), 2);
      await manager.update(
        Wallet,
        { id: wallet.id, company_id: String(companyId) },
        { balance: newBalance },
      );
      return {
        name: wallet.name,
        bankId: null,
        bankName: null,
        paymentMethod: PurchasePaymentMethod.CASH,
      };
    }

    // sourceType === 'cash_register'
    // CRIT-1 + HIGH-2 auditoría: `requireOpenCashRegisterForUpdate` lockea el
    // row del cash_register; `computeCashRegisterBalance` lee logs con el
    // MISMO manager transaccional. Dos pagos concurrentes desde la misma caja
    // serializan en el lock — el segundo recalcula balance tras el commit del
    // primero. `sourceId` del payload se ignora (paridad PlacePos).
    const open = await requireOpenCashRegisterForUpdate(manager, companyId);
    const balanceBig = await computeCashRegisterBalance(manager, open);
    if (amountBig.gt(balanceBig)) {
      throw new UnprocessableEntityException(
        `Saldo insuficiente en caja. Disponible: ${balanceBig.toFixed(2)}`,
      );
    }
    const log = manager.create(CashRegisterLog, {
      company_id: String(companyId),
      cash_register_id: open.id,
      type: CashRegisterLogType.CASH_OUT,
      direction: 'OUT',
      amount,
      affects_balance: true,
      description: 'Abono a compra (egreso de caja)',
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
    await manager.save(CashRegisterLog, log);
    return {
      name: 'Caja',
      bankId: null,
      bankName: null,
      paymentMethod: PurchasePaymentMethod.CASH,
    };
  }

  private async loadAggregate(
    manager: EntityManager,
    purchaseId: number,
    companyId: number,
  ): Promise<PurchaseAggregate> {
    const purchase = await findPurchaseInCompany(manager, purchaseId, companyId);
    const lines = await findPurchaseLines(manager, purchaseId, companyId);
    const credit = await findPurchaseCredit(manager, purchaseId, companyId);
    const payments = await findPurchasePayments(manager, purchaseId, companyId);
    return { purchase, lines, credit, payments };
  }
}
