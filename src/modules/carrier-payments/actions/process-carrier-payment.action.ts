import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { Carrier } from '@/modules/carriers/entities/carrier.entity';
import {
  CarrierCredit,
  CarrierCreditStatus,
} from '@/modules/carriers/entities/carrier-credit.entity';
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
import { Purchase } from '@/modules/purchases/entities/purchase.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { CreateCarrierPaymentDto } from '../dto/create-carrier-payment.dto';
import { CarrierPayment, CarrierPaymentMethod } from '../entities/carrier-payment.entity';

/**
 * Actor que registra el pago.
 */
export interface CarrierPaymentActor {
  id: number;
  fullName: string;
}

/**
 * Tolerancia para marcar PAID — alinea con `find-purchase-credit` y evita
 * que residuos sub-céntimo dejen el crédito en PARTIAL.
 */
const PAID_TOLERANCE_CENTS = new Big('0.01');

/**
 * Registra un abono a un transportista. Espejo de PlacePos
 * `POST /carrier-payments`.
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos (dentro de `dataSource.transaction`)
 * --------------------------------------------------------------------------
 *
 *   1. Lock pesimista del `CarrierCredit` (serializa pagos concurrentes
 *      sobre el mismo crédito).
 *   2. Validar `amount > 0` y `amount <= balance`. 422 si falla.
 *   3. Validar combinación método ↔ fuente:
 *        - CASH: bank_id/wallet_id deben ser null/undefined.
 *        - BANK: bank_id requerido, wallet_id prohibido.
 *        - WALLET: wallet_id requerido, bank_id prohibido.
 *   4. Cargar `Carrier` y `Purchase` para construir descripción canónica:
 *      `"Abono transportista {carrierName} - Compra Nº {purchaseNumber}"`.
 *   5. Resolver y debitar la fuente:
 *        - CASH: getOrCreateCashRegisterForUser(actor) — modelo PERMANENTE.
 *          Lock + UPDATE atómico de `cash_registers.balance -= amount`.
 *          Inserta CashRegisterLog(CARRIER_PAYMENT, OUT, affects_balance=true)
 *          como AUDITORÍA documental — el balance ya está mutado en la
 *          columna, el log no se re-aplica. Crea FM EXPENSE con
 *          source_type='cash_register', source_id=register.id.
 *        - BANK: lock pessimistic del banco; valida saldo; decrementa
 *          `Bank.balance`. FM EXPENSE con source=bank.
 *        - WALLET: idem para wallet.
 *   6. Insertar `CarrierPayment` con `financial_movement_id` del FM creado.
 *   7. Actualizar `CarrierCredit`: paid_amount += amount, balance -= amount,
 *      status = PAID si balance <= 1¢, sino PARTIAL.
 */
@Injectable()
export class ProcessCarrierPaymentAction {
  private readonly logger = new Logger(ProcessCarrierPaymentAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: CreateCarrierPaymentDto,
    companyId: number,
    actor: CarrierPaymentActor,
  ): Promise<CarrierPayment> {
    const amountBig = toBig(dto.amount);
    if (amountBig.lte(0)) {
      throw new UnprocessableEntityException('El monto del abono debe ser mayor a cero');
    }

    // Pre-validar combinaciones de método antes de abrir la transacción para
    // fallar rápido sin tomar locks.
    this.assertMethodSource(dto);

    return this.dataSource.transaction<CarrierPayment>(async (manager) => {
      // 1. Lock pessimistic del credit.
      const credit = await manager.findOne(CarrierCredit, {
        where: {
          id: String(dto.carrier_credit_id),
          company_id: String(companyId),
        },
        lock: { mode: 'pessimistic_write' },
      });
      if (!credit) {
        throw new NotFoundException('Crédito de transportista no encontrado');
      }

      const currentBalance = toBig(credit.balance);
      if (currentBalance.lte(0)) {
        throw new UnprocessableEntityException('El crédito ya está completamente pagado');
      }
      if (amountBig.gt(currentBalance)) {
        throw new UnprocessableEntityException(
          `El monto excede el saldo pendiente (${currentBalance.toFixed(2)})`,
        );
      }

      const amount = preciseNumber(amountBig, 2);

      // 2. Cargar Carrier + Purchase para descripción canónica.
      const carrier = await manager.findOne(Carrier, {
        where: { id: credit.carrier_id, company_id: String(companyId) },
      });
      if (!carrier) {
        // Estado inconsistente: el credit referencia un carrier que no existe
        // o cambió de company. No debería suceder bajo flujo normal.
        throw new NotFoundException('Transportista no encontrado');
      }
      const purchase = await manager.findOne(Purchase, {
        where: { id: credit.purchase_id, company_id: String(companyId) },
      });
      if (!purchase) {
        throw new NotFoundException('Compra asociada no encontrada');
      }

      // Description canónica con prioridad al texto del usuario (paridad
      // PlacePos `carrierPaymentOperations.ts`): si el usuario envía
      // `description` no vacío, ése es el texto definitivo que va al FM, al
      // log de caja y al CarrierPayment — los tres deben coincidir para que
      // los reportes crucen contra la misma cadena.
      const canonicalDescription = `Abono transportista ${carrier.name} - Compra Nº ${purchase.purchase_number}`;
      const description = dto.description?.trim() || canonicalDescription;

      // 3. Debitar fuente + crear FM. Devuelve el FM id para enlazar.
      const { financialMovementId } = await this.debitSourceAndRecordFm(
        manager,
        dto,
        amount,
        amountBig,
        companyId,
        actor,
        description,
      );

      // 4. Insertar CarrierPayment.
      const payment = manager.create(CarrierPayment, {
        company_id: String(companyId),
        carrier_credit_id: credit.id,
        amount,
        payment_method: dto.payment_method,
        bank_id:
          dto.payment_method === CarrierPaymentMethod.BANK && dto.bank_id !== undefined
            ? String(dto.bank_id)
            : null,
        wallet_id:
          dto.payment_method === CarrierPaymentMethod.WALLET && dto.wallet_id !== undefined
            ? String(dto.wallet_id)
            : null,
        financial_movement_id: String(financialMovementId),
        description,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });
      const savedPayment = await manager.save(CarrierPayment, payment);

      // 5. Actualizar el credit.
      const newPaid = preciseNumber(toBig(credit.paid_amount).plus(amountBig), 2);
      const newBalanceBig = currentBalance.minus(amountBig);
      const newBalance = preciseNumber(newBalanceBig, 2);
      const newStatus = newBalanceBig.lte(PAID_TOLERANCE_CENTS)
        ? CarrierCreditStatus.PAID
        : CarrierCreditStatus.PARTIAL;
      await manager.update(
        CarrierCredit,
        { id: credit.id, company_id: String(companyId) },
        { paid_amount: newPaid, balance: newBalance, status: newStatus },
      );

      this.logger.log({
        event: 'carrier_payment.processed',
        companyId,
        carrierId: Number(carrier.id),
        creditId: Number(credit.id),
        paymentId: Number(savedPayment.id),
        method: dto.payment_method,
        amount,
        newBalance,
        newStatus,
        actorId: actor.id,
      });

      return savedPayment;
    });
  }

  /**
   * Validación dura de la combinación método ↔ fuente (paso 3 del flujo).
   * 422 si inválido.
   */
  private assertMethodSource(dto: CreateCarrierPaymentDto): void {
    switch (dto.payment_method) {
      case CarrierPaymentMethod.CASH:
        // CASH ignora bank_id/wallet_id. Si vienen, rechazamos: el cliente
        // está enviando ruido — mejor fail explícito que bug latente.
        if (dto.bank_id !== undefined || dto.wallet_id !== undefined) {
          throw new UnprocessableEntityException(
            'payment_method=CASH no admite bank_id ni wallet_id',
          );
        }
        return;
      case CarrierPaymentMethod.BANK:
        if (dto.bank_id === undefined) {
          throw new UnprocessableEntityException('payment_method=BANK requiere bank_id');
        }
        if (dto.wallet_id !== undefined) {
          throw new UnprocessableEntityException('payment_method=BANK no admite wallet_id');
        }
        return;
      case CarrierPaymentMethod.WALLET:
        if (dto.wallet_id === undefined) {
          throw new UnprocessableEntityException('payment_method=WALLET requiere wallet_id');
        }
        if (dto.bank_id !== undefined) {
          throw new UnprocessableEntityException('payment_method=WALLET no admite bank_id');
        }
        return;
    }
  }

  /**
   * Resuelve la fuente, debita el saldo y registra el FinancialMovement.
   * Devuelve el id del FM para enlazar el `CarrierPayment.financial_movement_id`.
   */
  private async debitSourceAndRecordFm(
    manager: EntityManager,
    dto: CreateCarrierPaymentDto,
    amount: number,
    amountBig: Big,
    companyId: number,
    actor: CarrierPaymentActor,
    description: string,
  ): Promise<{ financialMovementId: number }> {
    if (dto.payment_method === CarrierPaymentMethod.BANK) {
      const bank = await manager.findOne(Bank, {
        where: {
          id: String(dto.bank_id),
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
      await manager.update(
        Bank,
        { id: bank.id, company_id: String(companyId) },
        { balance: preciseNumber(balance.minus(amountBig), 2) },
      );
      // Paridad PlacePos (`carrierPaymentOperations.ts` → `registerMovement`):
      // concept=CARRIER_PAYMENT y destination NULL (el carrier no es una
      // "cuenta" del sistema — es contraparte externa, pero PlacePos no la
      // referencia en el FM porque el `carrier_payments.financial_movement_id`
      // ya enlaza el FM con el pago, que a su vez referencia al carrier vía
      // carrier_credit_id).
      const fm = await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.CARRIER_PAYMENT,
        description,
        source_type: 'bank',
        source_id: Number(bank.id),
        destination_type: null,
        destination_id: null,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
      return { financialMovementId: Number(fm.id) };
    }

    if (dto.payment_method === CarrierPaymentMethod.WALLET) {
      const wallet = await manager.findOne(Wallet, {
        where: {
          id: String(dto.wallet_id),
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
      await manager.update(
        Wallet,
        { id: wallet.id, company_id: String(companyId) },
        { balance: preciseNumber(balance.minus(amountBig), 2) },
      );
      // Ver bloque BANK arriba para justificación de concept=CARRIER_PAYMENT y
      // destination=null. Paridad PlacePos `carrierPaymentOperations.ts`.
      const fm = await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.CARRIER_PAYMENT,
        description,
        source_type: 'wallet',
        source_id: Number(wallet.id),
        destination_type: null,
        destination_id: null,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
      return { financialMovementId: Number(fm.id) };
    }

    // CASH: usa la caja PERMANENTE del actor (resuelta por user_id).
    const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
    const cashBalance = toBig(register.balance);
    if (amountBig.gt(cashBalance)) {
      throw new UnprocessableEntityException(
        `Saldo insuficiente en caja. Disponible: ${cashBalance.toFixed(2)}`,
      );
    }
    const newBalance = preciseNumber(cashBalance.minus(amountBig), 2);
    await manager.update(
      CashRegister,
      { id: register.id, company_id: String(companyId) },
      { balance: newBalance },
    );

    // El log documenta la mutación que YA se hizo sobre register.balance.
    //
    // Paridad PlacePos (`carrierPaymentOperations.ts` → `registerMovement`):
    // `affects_balance = false`. PlacePos justifica: "el saldo de caja ya se
    // descontó en `deductFromMethod`; este log es informativo (rastro de
    // auditoría para reportes de actividad de caja), no debe sumarse al
    // recálculo del balance. Marcarlo true generaría doble contabilización
    // en cualquier script que sume los logs con affects_balance=true."
    //
    // Esta es la convención canónica PlacePos para el caso "balance ya
    // descontado por UPDATE directo": el log queda con affects_balance=false.
    const log = manager.create(CashRegisterLog, {
      company_id: String(companyId),
      cash_register_id: register.id,
      type: CashRegisterLogType.CARRIER_PAYMENT,
      direction: 'OUT',
      amount,
      affects_balance: false,
      description,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });
    await manager.save(CashRegisterLog, log);

    // FM "marcador" con source_type='cash_register' y source_id=NULL.
    // Paridad PlacePos (`carrierPaymentOperations.ts` → `registerMovement`,
    // rama CASH): "FM marcador: source/destination null porque el log de caja
    // ya describe el flujo. Sirve para satisfacer la FK NOT NULL [de
    // carrier_payments.financial_movement_id]."
    //
    // El CHECK `chk_financial_movements_source_consistency` ya fue relajado
    // (migración 1747010220000) para permitir source_type='cash_register' con
    // source_id NULL. El CHECK `chk_financial_movements_has_endpoint` se
    // satisface porque source_type es NOT NULL (aunque source_id sea NULL).
    const fm = await this.financialMovementsService.record(manager, {
      companyId,
      amount,
      movement_type: MovementType.EXPENSE,
      concept: MovementConcept.CARRIER_PAYMENT,
      description,
      source_type: 'cash_register',
      source_id: null,
      destination_type: null,
      destination_id: null,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });
    return { financialMovementId: Number(fm.id) };
  }
}
