import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { runSerializableWithRetry } from '@/common/utils/serializable-retry';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import { CashRegisterLogType } from '@/modules/cash-register/entities/cash-register-log.entity';
import { CashRegisterService } from '@/modules/cash-register/cash-register.service';
import {
  AccountReference,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { TransferDto, TransferDestinationType, TransferSourceType } from '../dto/transfer.dto';
import {
  ensureDifferentAccounts,
  loadAccountInCompany,
  setAccountBalance,
} from '../internal/account-types';

/**
 * Resultado de una transferencia. Espeja el shape de respuesta de PlacePos
 * (`accounts.routes.ts` devuelve `{ message }` + extendemos con balances
 * actualizados para que la UI no tenga que reconsultar).
 */
export interface TransferResult {
  message: string;
  source: { type: TransferSourceType; id: number; balance: number };
  destination: { type: TransferDestinationType; id: number; balance: number };
}

/**
 * Datos del actor — para snapshot en `created_by` / `created_by_id` de
 * los FinancialMovements y CashRegisterLog generados.
 */
export interface TransferActor {
  id: number;
  fullName: string;
}

/**
 * Transferencia entre dos cuentas DENTRO de UNA transacción.
 *
 * Combinaciones soportadas (espejo PlacePos `accounts.routes.ts`):
 *
 *   - bank → bank
 *   - bank → wallet
 *   - wallet → wallet
 *   - wallet → bank
 *   - wallet → user  (la "caja personal" del usuario destinatario)
 *
 * `bank → user` NO se permite (PlacePos tampoco lo expone): el flujo de
 * desembolso desde banco a un empleado debería ser un Expense (PAYROLL).
 *
 * Pasos atómicos comunes:
 *
 *   1. Validaciones previas (monto > 0, source !== destination).
 *   2. Lock pessimistic_write sobre la cuenta origen (bank/wallet).
 *   3. Validar saldo suficiente: `source.balance >= amount`. Si falla
 *      → 422 con mensaje literal de PlacePos: "Saldo insuficiente.
 *      Disponible: X".
 *   4. UPDATE source.balance -= amount.
 *   5. Acreditar destino:
 *        a) destination ∈ {bank, wallet}: lock pessimistic_write,
 *           UPDATE balance += amount.
 *        b) destination = user: resolver/crear la `cash_register` del
 *           usuario destinatario, UPDATE cash_registers.balance += amount,
 *           INSERT `cash_register_logs` (CASH_TRANSFER_IN, IN,
 *           affects_balance=true).
 *   6. Generar DOS `FinancialMovement` (EXPENSE en source + INCOME al
 *      destino) en el mismo manager. Ambos comparten `reference_code`
 *      (UUID v4) para que reportes puedan agrupar los dos lados.
 *
 *      Para destination=user, `destination_type` en los movements es
 *      `'cash_register'` con `destination_id` = id de la caja destino —
 *      así la auditoría apunta al receptáculo real del dinero, no al row
 *      lógico de users.
 *
 *   7. Si cualquier paso falla → rollback total.
 *
 * Concurrencia: `loadAccountInCompany` toma `pessimistic_write` sobre la
 * source y `getOrCreateCashRegisterForUser` también sobre la caja destino;
 * dos transferencias concurrentes sobre la misma source o misma caja se
 * serializan en Postgres sin escalar a SERIALIZABLE.
 */
@Injectable()
export class TransferAction {
  private readonly logger = new Logger(TransferAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
    private readonly cashRegisterService: CashRegisterService,
  ) {}

  async execute(
    dto: TransferDto,
    companyId: number,
    actor: TransferActor,
  ): Promise<TransferResult> {
    const amountBig: Big = toBig(dto.amount);
    if (amountBig.lte(0)) {
      throw new UnprocessableEntityException('El monto debe ser mayor a cero');
    }

    // PlacePos solo permite destination=user cuando source=wallet
    // (`accounts.routes.ts` lo construye así en `buildDestinationList`).
    // Replicamos esa restricción: bank → user se rechaza con 422 + code.
    if (dto.destinationType === 'user' && dto.sourceType !== 'wallet') {
      throw new UnprocessableEntityException({
        message: 'Solo se permite transferir a caja de usuario desde una wallet',
        payload: { code: 'INVALID_DESTINATION_FOR_SOURCE' },
      });
    }

    if (dto.destinationType !== 'user') {
      // source !== destination solo aplica entre cuentas administrativas;
      // cuando el destino es un user, la comparación de ids no aplica (son
      // espacios de id distintos).
      ensureDifferentAccounts(dto.sourceType, dto.sourceId, dto.destinationType, dto.destinationId);
    } else if (Number(dto.destinationId) === Number(actor.id)) {
      // I-8: autotransferencia wallet → mi propia caja. Lo bloqueamos
      // explícitamente — el dinero no cambia de mano, solo cruza tablas.
      throw new UnprocessableEntityException({
        message: 'No se puede transferir a la caja propia',
        payload: { code: 'SELF_TRANSFER' },
      });
    }

    // Aislamiento SERIALIZABLE (CLAUDE.md §9.4): transferencias entre cuentas
    // combinan read+write sobre source y destino. Con READ COMMITTED dos
    // transferencias concurrentes pueden leer el mismo balance y duplicar el
    // débito (write-skew). PG aborta con 40001 cuando detecta anomalía;
    // reintentamos hasta 2 veces.
    return runSerializableWithRetry<TransferResult>(this.dataSource, async (manager) => {
      // 1. Cargar source con lock pessimistic_write (defensa contra oversell).
      const source = await loadAccountInCompany(
        manager,
        dto.sourceType,
        dto.sourceId,
        companyId,
        'source',
      );

      const sourceBalanceBig = toBig(source.balance);
      if (amountBig.gt(sourceBalanceBig)) {
        throw new UnprocessableEntityException(
          `Saldo insuficiente. Disponible: ${sourceBalanceBig.toFixed(2)}`,
        );
      }

      const amount = preciseNumber(amountBig, 2);
      const newSourceBalance = preciseNumber(sourceBalanceBig.minus(amountBig), 2);

      // 2. UPDATE balance del source.
      await setAccountBalance(manager, dto.sourceType, source.id, companyId, newSourceBalance);

      // 3. Acreditar el destino + registrar movimientos.
      const referenceCode = `TRF-${randomUUID()}`;

      if (dto.destinationType === 'user') {
        return this.creditUserAndRecord({
          manager,
          companyId,
          source: {
            type: dto.sourceType,
            id: source.id,
            name: source.name,
            newBalance: newSourceBalance,
          },
          destinationUserId: dto.destinationId,
          amount,
          amountBig,
          referenceCode,
          actor,
        });
      }

      const destinationType: TransferSourceType = dto.destinationType;
      const destination = await loadAccountInCompany(
        manager,
        destinationType,
        dto.destinationId,
        companyId,
        'destination',
      );
      const newDestBalance = preciseNumber(toBig(destination.balance).plus(amountBig), 2);
      await setAccountBalance(manager, destinationType, destination.id, companyId, newDestBalance);

      await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.TRANSFER,
        description: `Traslado a ${destination.name}`,
        source_type: dto.sourceType,
        source_id: source.id,
        destination_type: destinationType,
        destination_id: destination.id,
        reference_code: referenceCode,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.INCOME,
        concept: MovementConcept.TRANSFER,
        description: `Traslado desde ${source.name}`,
        source_type: dto.sourceType,
        source_id: source.id,
        destination_type: destinationType,
        destination_id: destination.id,
        reference_code: referenceCode,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      this.logger.log({
        event: 'accounts.transfer_completed',
        companyId,
        actorId: actor.id,
        amount: amountBig.toFixed(2),
        sourceType: dto.sourceType,
        sourceId: source.id,
        destinationType,
        destinationId: destination.id,
        referenceCode,
      });

      return {
        message: `Traslado de ${amountBig.toFixed(2)} a ${destination.name} completado exitosamente`,
        source: { type: dto.sourceType, id: source.id, balance: newSourceBalance },
        destination: { type: destinationType, id: destination.id, balance: newDestBalance },
      };
    });
  }

  /**
   * Variante de la transferencia cuando el destino es la caja registradora
   * de otro usuario de la misma company. Encapsulado en helper privado para
   * mantener el `execute` legible.
   */
  private async creditUserAndRecord(params: {
    manager: EntityManager;
    companyId: number;
    source: {
      type: TransferSourceType;
      id: number;
      name: string;
      newBalance: number;
    };
    destinationUserId: number;
    amount: number;
    amountBig: Big;
    referenceCode: string;
    actor: TransferActor;
  }): Promise<TransferResult> {
    const {
      manager,
      companyId,
      source,
      destinationUserId,
      amount,
      amountBig,
      referenceCode,
      actor,
    } = params;

    // Validar que el user destino existe en la company (multi-tenant) y no
    // es superadmin. Sin esto, un owner podría disparar 404 cross-tenant.
    const destinationUser = await manager.findOne(User, {
      where: { id: String(destinationUserId), company_id: String(companyId) },
      select: { id: true, name: true, lastname: true, type: true },
    });
    if (!destinationUser || destinationUser.type === UserType.SUPERADMIN) {
      throw new NotFoundException('Usuario destino no encontrado');
    }

    const destinationName =
      `${destinationUser.name ?? ''} ${destinationUser.lastname ?? ''}`.trim() ||
      'Usuario desconocido';

    // Resolver/crear caja del destinatario + INSERT log + UPDATE balance,
    // todo dentro de la misma transacción vía CashRegisterService.record.
    // El `created_by` queda como el ACTOR (no el destinatario): es quien
    // movió el dinero, no quien lo recibe.
    const cashLog = await this.cashRegisterService.record(manager, {
      companyId,
      userId: destinationUserId,
      type: CashRegisterLogType.CASH_TRANSFER_IN,
      direction: 'IN',
      amount,
      affects_balance: true,
      description: `Traslado desde ${source.name}`,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });

    // Los financial movements apuntan a la caja real (id), no al user_id, para
    // que la auditoría refleje el receptáculo final del dinero.
    const destinationAccountRef: AccountReference = 'cash_register';

    await this.financialMovementsService.record(manager, {
      companyId,
      amount,
      movement_type: MovementType.EXPENSE,
      concept: MovementConcept.TRANSFER,
      description: `Traslado a ${destinationName}`,
      source_type: source.type,
      source_id: source.id,
      destination_type: destinationAccountRef,
      destination_id: cashLog.cashRegisterId,
      reference_code: referenceCode,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });

    await this.financialMovementsService.record(manager, {
      companyId,
      amount,
      movement_type: MovementType.INCOME,
      concept: MovementConcept.TRANSFER,
      description: `Traslado desde ${source.name}`,
      source_type: source.type,
      source_id: source.id,
      destination_type: destinationAccountRef,
      destination_id: cashLog.cashRegisterId,
      reference_code: referenceCode,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });

    // Releer la caja para obtener el balance ya actualizado. El SELECT no
    // agrega contención porque la fila ya está locked en esta misma
    // transacción por `getOrCreateCashRegisterForUser` (pessimistic_write).
    const updatedRegister = await manager.findOne(CashRegister, {
      where: { id: String(cashLog.cashRegisterId), company_id: String(companyId) },
      select: { balance: true },
    });
    const finalBalance = preciseNumber(toBig(updatedRegister?.balance ?? 0), 2);

    this.logger.log({
      event: 'accounts.transfer_completed',
      companyId,
      actorId: actor.id,
      amount: amountBig.toFixed(2),
      sourceType: source.type,
      sourceId: source.id,
      destinationType: 'user',
      destinationUserId,
      destinationCashRegisterId: cashLog.cashRegisterId,
      referenceCode,
    });

    return {
      message: `Traslado de ${amountBig.toFixed(2)} a ${destinationName} completado exitosamente`,
      source: { type: source.type, id: source.id, balance: source.newBalance },
      destination: {
        type: 'user',
        id: destinationUserId,
        balance: finalBalance,
      },
    };
  }
}
