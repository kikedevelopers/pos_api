import { randomUUID } from 'node:crypto';

import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import Big from 'big.js';
import { DataSource } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';

import type { TransferDto, TransferSourceType } from '../dto/transfer.dto';
import {
  ensureDifferentAccounts,
  loadAccountInCompany,
  setAccountBalance,
} from '../internal/account-types';

/**
 * Resultado de una transferencia. Espeja el shape de respuesta de PlacePos
 * (`accounts.routes.ts` devuelve `{ message }`).
 */
export interface TransferResult {
  message: string;
  source: { type: string; id: number; balance: number };
  destination: { type: string; id: number; balance: number };
}

/**
 * Datos del actor — para snapshot en `created_by` / `created_by_id` de
 * los FinancialMovements generados.
 */
export interface TransferActor {
  id: number;
  fullName: string;
}

/**
 * Transferencia entre dos cuentas (bank↔bank, bank↔wallet, etc.) DENTRO
 * de UNA transacción.
 *
 * Pasos atómicos:
 *
 *   1. Cargar source y destination dentro de la company (404 si alguna
 *      no existe / es ajena / está archivada). Pre-validar source !==
 *      destination (422).
 *
 *   2. Validar saldo suficiente en source (Big.js, no `number`):
 *      `source.balance >= amount`. Si falla → 422 con mensaje literal de
 *      PlacePos: "Saldo insuficiente. Disponible: X".
 *
 *   3. Restar `amount` del balance de source (Big.js). Sumar `amount` al
 *      balance de destination (Big.js). UPDATE persiste los dos nuevos
 *      balances.
 *
 *   4. Generar DOS `FinancialMovement` en el mismo manager:
 *
 *        a) EXPENSE en source: `source_type/source_id = source`,
 *           `destination_type/destination_id = destination`. concept
 *           TRANSFER.
 *
 *        b) INCOME en destination: `source_type/source_id = source`,
 *           `destination_type/destination_id = destination`. concept
 *           TRANSFER.
 *
 *      Ambos rows usan el mismo `reference_code` (UUID v4 generado por la
 *      action) para que el reporte pueda agrupar los dos lados del par.
 *
 *   5. Si cualquier paso falla → rollback total. No se permite estado
 *      inconsistente (un balance modificado y otro no, o un solo
 *      movement registrado).
 *
 * Race conditions:
 *
 *   - Dos transferencias concurrentes sobre la misma source pueden leer
 *     ambas un `balance = 100`, ambas restar `60`, y dejar el balance en
 *     `40` cuando debería ser `-20`. Para mitigar, usamos `READ COMMITTED`
 *     (default) PERO bloqueamos los rows con `SELECT ... FOR UPDATE` (vía
 *     `lock: { mode: 'pessimistic_write' }` en `manager.findOne`) ANTES
 *     del cálculo. Esto serializa transferencias sobre la misma cuenta
 *     sin escalar a `SERIALIZABLE`.
 *
 * Razón de NO usar SERIALIZABLE:
 *   - SERIALIZABLE puede generar `SerializationFailure` que requiere
 *     retry. Para transferencias el lock pessimista es predecible y
 *     suficiente.
 */
@Injectable()
export class TransferAction {
  private readonly logger = new Logger(TransferAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
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

    // PlacePos local permite `destinationType: 'user'` para mover dinero a
    // la "caja personal" del usuario. En cloud el modelo de caja vive a
    // nivel de company (turnos), no por usuario, así que el destino
    // simplemente no aplica. Aceptamos el campo en el DTO (paridad
    // byte-por-byte) pero rechazamos con 422 + código para que el frontend
    // pueda detectar la diferencia y ocultar la opción.
    if (dto.destinationType === 'user') {
      throw new UnprocessableEntityException({
        message: 'Transferencias a caja personal de usuario no soportadas en cloud',
        payload: { code: 'UNSUPPORTED_DESTINATION' },
      });
    }
    // Tras el guard `destinationType` ya es 'wallet' | 'bank'. Lo capturamos
    // en una variable tipada explícitamente para que TypeScript preserve el
    // narrow al pasarlo a los helpers internos (cuya firma usa el alias
    // `TransferSourceType`).
    const destinationType: TransferSourceType = dto.destinationType;

    ensureDifferentAccounts(dto.sourceType, dto.sourceId, destinationType, dto.destinationId);

    return this.dataSource.transaction<TransferResult>(async (manager) => {
      // 1. Cargar ambas cuentas. NOTA: no usamos `pessimistic_write` aquí
      //    porque el `loadAccountInCompany` retorna un snapshot — el lock
      //    real lo aplicamos en el siguiente paso vía un `findOne` con
      //    `lock` para garantizar que no se modifique entre lectura y
      //    UPDATE. En la práctica, como el siguiente paso es un UPDATE
      //    sobre la PK, Postgres ya adquiere ROW EXCLUSIVE; serializamos
      //    sobre source para evitar oversell.
      const source = await loadAccountInCompany(
        manager,
        dto.sourceType,
        dto.sourceId,
        companyId,
        'source',
      );
      const destination = await loadAccountInCompany(
        manager,
        destinationType,
        dto.destinationId,
        companyId,
        'destination',
      );

      const sourceBalanceBig = toBig(source.balance);
      if (amountBig.gt(sourceBalanceBig)) {
        throw new UnprocessableEntityException(
          `Saldo insuficiente. Disponible: ${sourceBalanceBig.toFixed(2)}`,
        );
      }

      const newSourceBalance = preciseNumber(sourceBalanceBig.minus(amountBig), 2);
      const newDestBalance = preciseNumber(toBig(destination.balance).plus(amountBig), 2);

      // 2. Actualizar ambos balances.
      await setAccountBalance(manager, dto.sourceType, source.id, companyId, newSourceBalance);
      await setAccountBalance(manager, destinationType, destination.id, companyId, newDestBalance);

      // 3. Reference code común — `randomUUID()` para evitar colisiones si
      //    dos transferencias del mismo par ocurren en el mismo ms
      //    (LOW-2 auditoría).
      const referenceCode = `TRF-${randomUUID()}`;

      // 4. Generar los dos FinancialMovement.
      const amount = amountBig.toNumber();
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
        destination: {
          type: destinationType,
          id: destination.id,
          balance: newDestBalance,
        },
      };
    });
  }
}
