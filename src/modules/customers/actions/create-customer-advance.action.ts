import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegisterLogType } from '@/modules/cash-register/entities/cash-register-log.entity';
import { CashRegisterService } from '@/modules/cash-register/cash-register.service';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { CreateCustomerAdvanceDto } from '../dto/create-customer-advance.dto';
import { Customer } from '../entities/customer.entity';
import { CustomerAdvance, type AdvanceDestinationType } from '../entities/customer-advance.entity';
import { findCustomerInCompany } from '../internal/customer-lookups';

/**
 * Actor (snapshot del usuario autenticado que registra el anticipo).
 *
 * Para destino `cash_register`, `id` se usa como `user_id` que resuelve la caja
 * PERMANENTE del cajero (getOrCreate server-side).
 */
export interface CustomerAdvanceActor {
  id: number;
  fullName: string;
}

/**
 * Resultado del endpoint `POST /customers/:id/advances`.
 *
 * Shape (contrato): `{ advance, customer }` con el customer ya re-leído tras
 * incrementar `advance_balance`.
 */
export interface CreateCustomerAdvanceResult {
  advance: CustomerAdvance;
  customer: Customer;
}

/**
 * Registra un anticipo de cliente — transacción atómica única.
 *
 * --------------------------------------------------------------------------
 * Aislamiento
 * --------------------------------------------------------------------------
 *
 * `READ COMMITTED` (default). Los recursos mutables (caja, banco, billetera,
 * customer) se bloquean con `pessimistic_write` dentro de la transacción, lo
 * que serializa anticipos concurrentes contra la misma cuenta/cliente sin
 * necesidad de SERIALIZABLE. El incremento de `advance_balance` se hace bajo
 * lock del row del customer para evitar lost-updates.
 *
 * --------------------------------------------------------------------------
 * Pasos (contrato `CONTRACT_customer_advance_archive.md` §3)
 * --------------------------------------------------------------------------
 *
 *   1. Validar customer (+ tenancy) con lock pessimistic_write.
 *   2. Registrar INGRESO de dinero en la cuenta destino:
 *        - cash_register → CashRegisterService.record(type=CUSTOMER_ADVANCE,
 *          direction=IN, affects_balance=true), resolviendo la caja del actor
 *          por user_id. El id real de esa caja se guarda en destination_id.
 *        - bank | wallet → lock + UPDATE balance += amount + FinancialMovement
 *          (concept=CUSTOMER_ADVANCE, INCOME, destination=banco/billetera).
 *   3. INSERT customer_advances.
 *   4. customers.advance_balance += amount (Big.js) bajo el lock del paso 1.
 *   5. Commit. Devolver { advance, customer } re-leído.
 *
 * Money: todo cálculo con Big.js (`toBig`/`preciseNumber`). El amount llega
 * validado > 0 por el DTO.
 */
@Injectable()
export class CreateCustomerAdvanceAction {
  private readonly logger = new Logger(CreateCustomerAdvanceAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly cashRegisterService: CashRegisterService,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    customerId: number,
    dto: CreateCustomerAdvanceDto,
    companyId: number,
    actor: CustomerAdvanceActor,
  ): Promise<CreateCustomerAdvanceResult> {
    const amountBig = toBig(dto.amount);
    const amount = preciseNumber(amountBig, 2);
    const description = dto.description.trim();
    const referenceCode = `ADV-${randomUUID()}`;

    return this.dataSource.transaction<CreateCustomerAdvanceResult>(async (manager) => {
      // 1. Customer + tenancy, lockeado para el incremento posterior.
      const customer = await manager.findOne(Customer, {
        where: { id: String(customerId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!customer) {
        throw new NotFoundException('Cliente no encontrado');
      }

      const logDescription = `Anticipo cliente ${customer.name}: ${description}`;

      // 2. Registrar el ingreso de dinero según destino y resolver el
      //    destination_id real a persistir.
      const resolvedDestinationId = await this.recordIncome(
        manager,
        dto.destination_type,
        dto.destination_id,
        companyId,
        amountBig,
        amount,
        logDescription,
        referenceCode,
        actor,
      );

      // 3. INSERT customer_advances.
      const advanceRepo = manager.getRepository(CustomerAdvance);
      const advance = await advanceRepo.save(
        advanceRepo.create({
          company_id: String(companyId),
          customer_id: String(customerId),
          amount,
          description,
          destination_type: dto.destination_type,
          destination_id: String(resolvedDestinationId),
          reference_code: referenceCode,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        }),
      );

      // 4. customers.advance_balance += amount (Big.js, bajo lock del paso 1).
      const newAdvanceBalance = preciseNumber(toBig(customer.advance_balance).plus(amountBig), 2);
      await manager.update(
        Customer,
        { id: String(customerId), company_id: String(companyId) },
        { advance_balance: newAdvanceBalance },
      );

      // 5. Re-fetch del customer con el balance ya actualizado.
      const updatedCustomer = await findCustomerInCompany(manager, customerId, companyId);

      this.logger.log({
        event: 'customer.advance_created',
        companyId,
        customerId,
        amount,
        destinationType: dto.destination_type,
        destinationId: resolvedDestinationId,
        referenceCode,
        actorId: actor.id,
      });

      return { advance, customer: updatedCustomer };
    });
  }

  /**
   * Registra el INGRESO de dinero en la cuenta destino y devuelve el
   * `destination_id` real a persistir en `customer_advances`.
   *
   *   - cash_register: delega en CashRegisterService.record (resuelve la caja
   *     del actor por user_id, afecta balance). Devuelve el id de esa caja.
   *   - bank | wallet: lock pessimistic_write + UPDATE balance += amount +
   *     FinancialMovement(concept=CUSTOMER_ADVANCE, INCOME).
   */
  private async recordIncome(
    manager: EntityManager,
    destinationType: AdvanceDestinationType,
    destinationId: number | undefined,
    companyId: number,
    amountBig: ReturnType<typeof toBig>,
    amount: number,
    description: string,
    referenceCode: string,
    actor: CustomerAdvanceActor,
  ): Promise<number> {
    if (destinationType === 'cash_register') {
      const { cashRegisterId } = await this.cashRegisterService.record(manager, {
        companyId,
        userId: actor.id,
        type: CashRegisterLogType.CUSTOMER_ADVANCE,
        direction: 'IN',
        amount,
        affects_balance: true,
        description,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
      return cashRegisterId;
    }

    // bank | wallet — el DTO garantiza destination_id presente.
    if (destinationId === undefined) {
      // Defensa en profundidad: el DTO ya lo exige para bank/wallet.
      throw new NotFoundException('destination_id requerido para bank/wallet');
    }

    if (destinationType === 'bank') {
      const bank = await manager.findOne(Bank, {
        where: { id: String(destinationId), company_id: String(companyId), is_archived: false },
        lock: { mode: 'pessimistic_write' },
      });
      if (!bank) {
        throw new NotFoundException('Banco no encontrado');
      }
      const newBalance = preciseNumber(toBig(bank.balance).plus(amountBig), 2);
      await manager.update(
        Bank,
        { id: bank.id, company_id: String(companyId) },
        {
          balance: newBalance,
        },
      );
      await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.INCOME,
        concept: MovementConcept.CUSTOMER_ADVANCE,
        description,
        destination_type: 'bank',
        destination_id: Number(bank.id),
        reference_code: referenceCode,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
      return Number(bank.id);
    }

    // destinationType === 'wallet'
    const wallet = await manager.findOne(Wallet, {
      where: { id: String(destinationId), company_id: String(companyId), is_archived: false },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new NotFoundException('Billetera no encontrada');
    }
    const newBalance = preciseNumber(toBig(wallet.balance).plus(amountBig), 2);
    await manager.update(
      Wallet,
      { id: wallet.id, company_id: String(companyId) },
      {
        balance: newBalance,
      },
    );
    await this.financialMovementsService.record(manager, {
      companyId,
      amount,
      movement_type: MovementType.INCOME,
      concept: MovementConcept.CUSTOMER_ADVANCE,
      description,
      destination_type: 'wallet',
      destination_id: Number(wallet.id),
      reference_code: referenceCode,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });
    return Number(wallet.id);
  }
}
