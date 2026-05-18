import { Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type Big from 'big.js';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';

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
import type { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { PurchasePaymentSource } from '../dto/create-purchase-payment.dto';
import { PurchaseCredit, PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import { PurchasePayment, PurchasePaymentMethod } from '../entities/purchase-payment.entity';

import {
  isPurchasePaymentUuidConflict,
  translatePurchaseConstraintError,
} from './constraint-errors';
import { findPurchaseCredit, findPurchaseInCompany } from './purchase-lookups';
import { nextPaymentNumber } from './purchase-number';

const logger = new Logger('ApplyPurchasePaymentHelper');

/**
 * Actor que registra el abono (snapshot guardado en `created_by`/`created_by_id`).
 */
export interface ApplyPurchasePaymentActor {
  id: number;
  fullName: string;
}

/**
 * Parámetros del abono que el helper aplica DENTRO de la transacción del caller.
 */
export interface ApplyPurchasePaymentParams {
  purchaseId: number;
  source_type: PurchasePaymentSource;
  source_id: number;
  amount: number | string;
  notes?: string | null;
  /**
   * Idempotency key. Si llega un uuid ya procesado para la misma compra,
   * devuelve el pago existente (`idempotent: true`). Para uuid recibido por
   * otra compra, lanza 422.
   *
   * Si no se especifica, el helper genera uno automáticamente (cliente legacy).
   */
  uuid?: string | null;
}

/**
 * Resultado de aplicar un abono. Se usa tanto por el flujo single
 * (`RegisterPurchasePaymentAction`) como por el bulk
 * (`ProcessBulkPurchasePaymentsAction`).
 */
export interface ApplyPurchasePaymentResult {
  payment: PurchasePayment;
  /**
   * `true` cuando el fast-path uuid encontró un row ya persistido y se
   * devolvió sin reaplicar. El caller usa esto para diferenciar HTTP 200 vs
   * HTTP 201.
   */
  idempotent: boolean;
  /**
   * Estado final del PurchaseCredit tras aplicar el pago. Permite que el bulk
   * arme su payload de respuesta sin re-leer el credit.
   */
  credit_status: PurchaseCreditStatus;
  credit_balance: number;
}

interface ResolvedSource {
  name: string;
  bankId: number | null;
  bankName: string | null;
  paymentMethod: PurchasePaymentMethod;
}

/**
 * Aplica un abono a una compra DENTRO de la transacción del caller.
 *
 * --------------------------------------------------------------------------
 * Por qué un helper y no una action
 * --------------------------------------------------------------------------
 *
 * El bulk (`POST /purchases/bulk-payments`) necesita aplicar N abonos en UNA
 * sola transacción SERIALIZABLE (si uno falla, TODOS revierten). Como cada
 * `@Injectable()` action abre su propia transacción interna, no se puede
 * componer directamente. Este helper recibe el `manager` desde fuera y
 * delega la decisión transaccional al caller.
 *
 * --------------------------------------------------------------------------
 * Pasos
 * --------------------------------------------------------------------------
 *
 *   1. Idempotencia: si llega `uuid` y ya existe para esta compra → devuelve
 *      el row existente sin reprocesar.
 *   2. Lock + lectura del PurchaseCredit (lock pessimistic_write para serializar
 *      pagos concurrentes sobre la misma compra).
 *   3. Validar saldo solicitado <= balance pendiente.
 *   4. Resolver y debitar la fuente (wallet/bank/cash_register) con
 *      pessimistic_write en cada caso.
 *   5. INSERT PurchasePayment con folio per-company.
 *   6. INSERT FinancialMovement (EXPENSE, PURCHASE).
 *   7. UPDATE PurchaseCredit (paid_amount, balance, status).
 *   8. Decrementar supplier.accumulated_debt.
 *
 * El uuid race-condition (mismo uuid llega por dos paths concurrentes) se
 * resuelve detectando SQLSTATE 23505 sobre el constraint del uuid y releyendo
 * al ganador.
 */
export async function applyPurchasePayment(
  manager: EntityManager,
  companyId: number,
  params: ApplyPurchasePaymentParams,
  actor: ApplyPurchasePaymentActor,
  financialMovementsService: FinancialMovementsService,
): Promise<ApplyPurchasePaymentResult> {
  const idempotencyKey = params.uuid ?? randomUUID();
  const amountBig: Big = toBig(params.amount);
  if (amountBig.lte(0)) {
    throw new UnprocessableEntityException('El monto del abono debe ser mayor a cero');
  }
  const amount = preciseNumber(amountBig, 2);

  // 1. Pre-validar compra activa antes del fast-path. Evita que un fast-path
  //    devuelva un pago "histórico" sobre una compra anulada como si fuera
  //    nuevo abono.
  const purchase = await findPurchaseInCompany(manager, params.purchaseId, companyId, {
    requireActive: true,
  });

  // 2. Fast-path idempotencia. Mismo uuid → devolver el row existente.
  const existing = await manager.findOne(PurchasePayment, {
    where: { company_id: String(companyId), uuid: idempotencyKey },
  });
  if (existing) {
    if (Number(existing.purchase_id) !== params.purchaseId) {
      throw new UnprocessableEntityException('El uuid ya fue utilizado para otra compra');
    }
    // Releer credit para reportar status final.
    const creditNow = await findPurchaseCredit(manager, params.purchaseId, companyId);
    return {
      payment: existing,
      idempotent: true,
      credit_status: creditNow ? creditNow.status : PurchaseCreditStatus.PENDING,
      credit_balance: creditNow ? Number(creditNow.balance) : 0,
    };
  }

  // 3. Lock + validación del credit.
  const credit = await manager
    .createQueryBuilder(PurchaseCredit, 'pc')
    .setLock('pessimistic_write')
    .where('pc.purchase_id = :id AND pc.company_id = :companyId', {
      id: String(purchase.id),
      companyId: String(companyId),
    })
    .getOne();
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

  // 4. Debitar la fuente.
  const source = await debitSource(
    manager,
    companyId,
    params.source_type,
    params.source_id,
    amountBig,
    actor,
  );

  // 5. INSERT PurchasePayment con folio per-company.
  const paymentNumber = await nextPaymentNumber(manager, companyId);
  const paymentEntity = manager.create(PurchasePayment, {
    company_id: String(companyId),
    purchase_id: purchase.id,
    payment_number: paymentNumber,
    payment_method: source.paymentMethod,
    amount,
    bank_id: source.bankId === null ? null : String(source.bankId),
    bank_name: source.bankName,
    source_type: params.source_type,
    source_id: String(params.source_id),
    notes: params.notes ?? null,
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
      const creditNow = await findPurchaseCredit(manager, params.purchaseId, companyId);
      return {
        payment: winner,
        idempotent: true,
        credit_status: creditNow ? creditNow.status : PurchaseCreditStatus.PENDING,
        credit_balance: creditNow ? Number(creditNow.balance) : 0,
      };
    }
    translatePurchaseConstraintError(error);
    throw error;
  }

  // 6. FinancialMovement (EXPENSE, PURCHASE) atribuido al supplier.
  await financialMovementsService.record(manager, {
    companyId,
    amount,
    movement_type: MovementType.EXPENSE,
    concept: MovementConcept.PURCHASE,
    description: `Abono a compra ${purchase.purchase_number} (${purchase.supplier_name})`,
    source_type: params.source_type,
    source_id: params.source_id,
    destination_type: 'external',
    destination_id: Number(purchase.supplier_id),
    reference_code: `PAY-${paymentNumber}`,
    created_by: actor.fullName,
    created_by_id: actor.id,
  });

  // 7. UPDATE PurchaseCredit.
  const newPaid = preciseNumber(toBig(credit.paid_amount).plus(amountBig), 2);
  const newBalanceBig = currentBalance.minus(amountBig);
  const newBalance = preciseNumber(newBalanceBig, 2);
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

  // 8. Decrementar deuda acumulada del proveedor.
  await manager.decrement(
    Supplier,
    { id: purchase.supplier_id, company_id: String(companyId) },
    'accumulated_debt',
    amount,
  );

  logger.log({
    event: 'purchase.payment_applied',
    companyId,
    purchaseId: params.purchaseId,
    paymentId: Number(savedPayment.id),
    paymentNumber,
    sourceType: params.source_type,
    sourceId: params.source_id,
    amount,
    newBalance,
    newStatus,
    actorId: actor.id,
  });

  return {
    payment: savedPayment,
    idempotent: false,
    credit_status: newStatus,
    credit_balance: newBalance,
  };
}

/**
 * Resuelve y debita la fuente del abono (wallet/bank/cash_register) con
 * pessimistic_write para serializar abonos concurrentes contra la misma
 * cuenta. Defensa contra lost-update de balance.
 */
async function debitSource(
  manager: EntityManager,
  companyId: number,
  sourceType: PurchasePaymentSource,
  sourceId: number,
  amountBig: Big,
  actor: ApplyPurchasePaymentActor,
): Promise<ResolvedSource> {
  const amount = preciseNumber(amountBig, 2);

  if (sourceType === 'bank') {
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

  // sourceType === 'cash_register' — la caja del actor se resuelve por user_id
  // con lock pessimistic_write. Dos pagos concurrentes desde la misma caja
  // serializan en el lock. `sourceId` del payload se ignora (paridad PlacePos).
  const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
  const balanceBig = toBig(register.balance);
  if (amountBig.gt(balanceBig)) {
    throw new UnprocessableEntityException(
      `Saldo insuficiente en caja. Disponible: ${balanceBig.toFixed(2)}`,
    );
  }
  const newBalance = preciseNumber(balanceBig.minus(amountBig), 2);
  await manager.update(
    CashRegister,
    { id: register.id, company_id: String(companyId) },
    { balance: newBalance },
  );
  const log = manager.create(CashRegisterLog, {
    company_id: String(companyId),
    cash_register_id: register.id,
    type: CashRegisterLogType.PURCHASE_PAYMENT,
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
