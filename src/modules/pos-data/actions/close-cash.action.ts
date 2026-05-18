import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, Like, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { CashRegister } from '@/modules/cash-register/entities/cash-register.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import { getOrCreateCashRegisterForUser } from '@/modules/cash-register/internal/get-or-create-cash-register-for-user.helper';
import {
  AccountReference,
  FinancialMovement,
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { CloseCashDto } from '../dto/close-cash.dto';
import type { PosDataDestinationType } from '../dto/transfer-cash.dto';

/**
 * Datos del actor — para `created_by` / `created_by_id` en logs y FMs.
 */
export interface CloseCashActor {
  id: number;
  fullName: string;
}

/**
 * Resultado del cierre de caja. Espejo PlacePos byte-por-byte:
 *
 *   - `message`: confirmación legible.
 *   - `moved_amount`: total movido al destino (suma de TRANSFER_OUTs).
 *   - `difference`: counted - balance (>0 sobrante, <0 faltante, 0 cuadre).
 *   - `new_balance`: balance final de la caja tras el cierre.
 */
export interface CloseCashResult {
  message: string;
  moved_amount: number;
  difference: number;
  new_balance: number;
}

type ResolvedDestination = 'wallet' | 'bank';

interface TransferTarget {
  destinationType: ResolvedDestination;
  destinationId: number;
}

interface ExecuteTransferOutParams {
  manager: EntityManager;
  companyId: number;
  cashRegisterId: number;
  sourceCurrentBalance: number;
  target: TransferTarget;
  amountBig: Big;
  actor: CloseCashActor;
  /**
   * Etiqueta legible del origen (e.g. "Caja de Juan Pérez"). Aceptada en la
   * interfaz por paridad con el helper PlacePos pero no usada en cloud: los
   * destinos `bank|wallet` no tienen log propio donde colgar el texto.
   */
  sourceLabel?: string;
  logDescription?: string;
  financialDescription?: string;
  /**
   * Si el cliente pasó `Idempotency-Key`, lo propagamos al `reference_code`
   * del `FinancialMovement` resultante para que el fast-path lo detecte en
   * reintentos.
   */
  idempotencyKey?: string | null;
}

interface ExecuteTransferOutResult {
  destinationName: string;
  newSourceBalance: number;
}

/**
 * `POST /pos-data/close-cash`. Cierre de caja con dos modos (paridad PlacePos).
 *
 *   - Simple (`reconcile=false`): traslada `amount_to_transfer` al destino y
 *     deja la caja en `(balance - amount_to_transfer)`. Errores de negocio:
 *       * `amount_to_transfer == 0`              → 422 NOTHING_TO_REGISTER
 *       * `amount_to_transfer > balance`         → 422 INSUFFICIENT_BALANCE
 *       * destino faltante / mal tipado          → 422 DESTINATION_REQUIRED
 *
 *   - Reconcile (`reconcile=true`): exige `counted_amount` y destino, deja la
 *     caja en `base_amount`. La diferencia `counted - balance` se registra:
 *       * `>0` sobrante: log `CASH_OVERAGE` (IN, affects_balance=true) +
 *         FM `INCOME/ADJUSTMENT`. Luego DOS TRANSFER_OUT al destino: principal
 *         (`balance - base`) + ajuste (`diff`).
 *       * `<0` faltante: log `CASH_SHORTAGE` (OUT, affects_balance=true) +
 *         FM `EXPENSE/ADJUSTMENT` sin destino (pérdida). Luego un único
 *         TRANSFER_OUT por `(counted - base)`.
 *       * `0` cuadre: un único TRANSFER_OUT por `(balance - base)`.
 *     Errores de negocio:
 *       * `counted_amount < base_amount`         → 422 COUNTED_BELOW_BASE
 *       * Sin nada que registrar                 → 422 NOTHING_TO_REGISTER
 *       * destino faltante                       → 422 DESTINATION_REQUIRED
 *
 * Atomicidad: una sola `dataSource.transaction(...)`. La caja se lockea con
 * `getOrCreateCashRegisterForUser` (pessimistic_write); el destino se lockea
 * dentro de `executeCashTransferOut`. El destino `'user'` se rechaza con
 * `422 UNSUPPORTED_DESTINATION` igual que en `transfer-cash`.
 *
 * --------------------------------------------------------------------------
 * Idempotencia opcional (header `Idempotency-Key`)
 * --------------------------------------------------------------------------
 *
 * Cuando el controller recibe un `Idempotency-Key` UUID v4, lo propaga aquí.
 * Antes de abrir la transacción buscamos un `FinancialMovement` previo con
 * `reference_code LIKE 'POS-CC-IDEMP-<key>-%'`. Si existe → reconstruimos el
 * resultado leyendo los FMs persistidos (sin re-cobrar al destino).
 *
 * Decisión: NO se añade una tabla/columna nueva para la idempotencia. Usamos
 * el `reference_code` ya existente en `FinancialMovement` (prefijo
 * `POS-CC-IDEMP-<key>-OVR|SHT|TRF-<rand>`). Costo: una columna nueva
 * tipo `idempotency_key` permitiría índice único; con el prefijo confiamos en
 * el `LIKE` indexable (la tabla tiene índice por `company_id`). Si en el
 * futuro la frecuencia de cierres con key sube, conviene migrar a columna
 * propia con UNIQUE `(company_id, idempotency_key)`.
 *
 * Limitación conocida: `new_balance` re-leído en un hit idempotente refleja
 * el balance ACTUAL de la caja, no el snapshot del cierre original (otros
 * cobros pueden haber alterado el saldo después). PlacePos tiene el mismo
 * comportamiento — el frontend usa `moved_amount`/`difference` para auditar.
 *
 * Sin header → comportamiento legacy (sin idempotencia, reintentos crean
 * cierres duplicados — responsabilidad del cliente evitarlo).
 */
@Injectable()
export class CloseCashAction {
  private readonly logger = new Logger(CloseCashAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: CloseCashDto,
    companyId: number,
    actor: CloseCashActor,
    idempotencyKey: string | null = null,
  ): Promise<CloseCashResult> {
    const reconcile = dto.reconcile === true;
    const target = this.validateAndNarrowDestination(dto, reconcile);

    // Fast-path idempotencia: si el cliente envió `Idempotency-Key` y ya hay
    // un cierre previo con esa key, reconstruimos el resultado a partir de
    // los FMs persistidos. Lectura puro (sin transacción) — los FMs no se
    // modifican post-creación.
    if (idempotencyKey) {
      const replay = await this.tryReplayIdempotent(companyId, actor.id, idempotencyKey);
      if (replay) {
        this.logger.log({
          event: 'pos_data.close_cash_idempotent_hit',
          companyId,
          actorId: actor.id,
          idempotencyKey,
          movedAmount: replay.moved_amount,
          difference: replay.difference,
        });
        return replay;
      }
    }

    return this.dataSource.transaction<CloseCashResult>(async (manager) => {
      const register = await getOrCreateCashRegisterForUser(manager, companyId, actor.id);
      const systemBalanceBig = toBig(register.balance);
      const baseBig = toBig(register.base_amount);
      const sourceLabel = `Caja de ${actor.fullName}`.trim();

      const result = reconcile
        ? await this.reconcileMode({
            manager,
            companyId,
            cashRegisterId: Number(register.id),
            systemBalanceBig,
            baseBig,
            countedBig: toBig(dto.counted_amount ?? 0).round(2),
            target: target as TransferTarget,
            actor,
            sourceLabel,
            idempotencyKey,
          })
        : await this.simpleMode({
            manager,
            companyId,
            cashRegisterId: Number(register.id),
            systemBalanceBig,
            transferBig: toBig(dto.amount_to_transfer).round(2),
            target,
            actor,
            sourceLabel,
            idempotencyKey,
          });

      this.logger.log({
        event: 'pos_data.close_cash_completed',
        companyId,
        actorId: actor.id,
        cashRegisterId: Number(register.id),
        reconcile,
        movedAmount: result.moved_amount,
        difference: result.difference,
        newBalance: result.new_balance,
      });

      return {
        message: 'Cierre de caja completado exitosamente',
        moved_amount: result.moved_amount,
        difference: result.difference,
        new_balance: result.new_balance,
      };
    });
  }

  /**
   * Valida el destino segun el modo y estrecha el tipo a `'wallet'|'bank'`.
   * Devuelve `null` SOLO en modo simple cuando `amount_to_transfer = 0` (caso
   * que dispararía `NOTHING_TO_REGISTER` aguas abajo).
   */
  private validateAndNarrowDestination(
    dto: CloseCashDto,
    reconcile: boolean,
  ): TransferTarget | null {
    if (dto.destinationType === 'user') {
      throw new UnprocessableEntityException({
        message: 'Transferencias a caja personal de usuario no soportadas en cloud',
        payload: { code: 'UNSUPPORTED_DESTINATION' },
      });
    }

    const requiresDestination = reconcile || dto.amount_to_transfer > 0;
    if (!requiresDestination) {
      // Modo simple con monto 0 → no se necesita destino (caerá en
      // NOTHING_TO_REGISTER al ejecutar).
      return null;
    }

    if (!dto.destinationType || typeof dto.destinationId !== 'number') {
      throw new UnprocessableEntityException({
        message: reconcile
          ? 'Destino requerido para conciliar caja'
          : 'Destino requerido para transferir',
        payload: { code: 'DESTINATION_REQUIRED' },
      });
    }

    const destinationType: ResolvedDestination = dto.destinationType;
    return { destinationType, destinationId: dto.destinationId };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Modo simple
  // ──────────────────────────────────────────────────────────────────────────

  private async simpleMode(params: {
    manager: EntityManager;
    companyId: number;
    cashRegisterId: number;
    systemBalanceBig: Big;
    transferBig: Big;
    target: TransferTarget | null;
    actor: CloseCashActor;
    sourceLabel: string;
    idempotencyKey: string | null;
  }): Promise<Omit<CloseCashResult, 'message'>> {
    const {
      manager,
      companyId,
      cashRegisterId,
      systemBalanceBig,
      transferBig,
      target,
      actor,
      sourceLabel,
      idempotencyKey,
    } = params;

    if (transferBig.eq(0)) {
      throw new UnprocessableEntityException({
        message: 'Nada que registrar',
        payload: { code: 'NOTHING_TO_REGISTER' },
      });
    }
    if (transferBig.gt(systemBalanceBig)) {
      throw new UnprocessableEntityException({
        message: 'No se puede transferir más del saldo disponible en la caja',
        payload: { code: 'INSUFFICIENT_BALANCE' },
      });
    }
    if (!target) {
      // Defense in depth — validateAndNarrowDestination ya cubre el caso, pero
      // un transferBig > 0 sin target sería un bug.
      throw new UnprocessableEntityException({
        message: 'Destino requerido para transferir',
        payload: { code: 'DESTINATION_REQUIRED' },
      });
    }

    const { newSourceBalance } = await this.executeCashTransferOut({
      manager,
      companyId,
      cashRegisterId,
      sourceCurrentBalance: systemBalanceBig.toNumber(),
      target,
      amountBig: transferBig,
      actor,
      sourceLabel,
      idempotencyKey,
    });

    return {
      moved_amount: preciseNumber(transferBig, 2),
      difference: 0,
      new_balance: newSourceBalance,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Modo conciliación
  // ──────────────────────────────────────────────────────────────────────────

  private async reconcileMode(params: {
    manager: EntityManager;
    companyId: number;
    cashRegisterId: number;
    systemBalanceBig: Big;
    baseBig: Big;
    countedBig: Big;
    target: TransferTarget;
    actor: CloseCashActor;
    sourceLabel: string;
    idempotencyKey: string | null;
  }): Promise<Omit<CloseCashResult, 'message'>> {
    const {
      manager,
      companyId,
      cashRegisterId,
      systemBalanceBig,
      baseBig,
      countedBig,
      target,
      actor,
      sourceLabel,
      idempotencyKey,
    } = params;

    if (countedBig.lt(baseBig)) {
      throw new UnprocessableEntityException({
        message: 'El efectivo contado no alcanza para cubrir el fondo fijo',
        payload: { code: 'COUNTED_BELOW_BASE' },
      });
    }

    const diffBig = countedBig.minus(systemBalanceBig).round(2);
    const totalOutflowBig = countedBig.minus(baseBig).round(2);

    if (totalOutflowBig.eq(0) && diffBig.eq(0)) {
      throw new UnprocessableEntityException({
        message: 'Nada que registrar',
        payload: { code: 'NOTHING_TO_REGISTER' },
      });
    }

    let workingBalance = systemBalanceBig.toNumber();

    // Sobrante: alineamos el sistema al físico (entra el sobrante en caja).
    if (diffBig.gt(0)) {
      const absDiff = diffBig;
      const newBalance = preciseNumber(systemBalanceBig.plus(absDiff), 2);

      await manager.update(
        CashRegister,
        { id: String(cashRegisterId), company_id: String(companyId) },
        { balance: newBalance },
      );

      await manager.getRepository(CashRegisterLog).save({
        company_id: String(companyId),
        cash_register_id: String(cashRegisterId),
        type: CashRegisterLogType.CASH_OVERAGE,
        direction: 'IN',
        amount: preciseNumber(absDiff, 2),
        affects_balance: true,
        description: `Sobrante detectado en cierre de caja: $${absDiff.toFixed(2)}.`,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });

      await this.financialMovementsService.record(manager, {
        companyId,
        amount: preciseNumber(absDiff, 2),
        movement_type: MovementType.INCOME,
        concept: MovementConcept.ADJUSTMENT,
        description: `Ajuste por sobrante en ${sourceLabel}.`,
        source_type: null,
        source_id: null,
        destination_type: 'cash_register',
        destination_id: cashRegisterId,
        reference_code: this.buildReferenceCode('OVR', idempotencyKey),
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      workingBalance = newBalance;
    } else if (diffBig.lt(0)) {
      // Faltante: pérdida pura sin destino — la caja se ajusta hacia abajo.
      const absDiff = diffBig.abs();
      const newBalance = preciseNumber(systemBalanceBig.minus(absDiff), 2);

      await manager.update(
        CashRegister,
        { id: String(cashRegisterId), company_id: String(companyId) },
        { balance: newBalance },
      );

      await manager.getRepository(CashRegisterLog).save({
        company_id: String(companyId),
        cash_register_id: String(cashRegisterId),
        type: CashRegisterLogType.CASH_SHORTAGE,
        direction: 'OUT',
        amount: preciseNumber(absDiff, 2),
        affects_balance: true,
        description: `Faltante detectado en cierre de caja: $${absDiff.toFixed(2)}.`,
        created_by: actor.fullName,
        created_by_id: String(actor.id),
      });

      await this.financialMovementsService.record(manager, {
        companyId,
        amount: preciseNumber(absDiff, 2),
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.ADJUSTMENT,
        description: `Ajuste por faltante en ${sourceLabel}.`,
        source_type: 'cash_register',
        source_id: cashRegisterId,
        destination_type: null,
        destination_id: null,
        reference_code: this.buildReferenceCode('SHT', idempotencyKey),
        created_by: actor.fullName,
        created_by_id: actor.id,
      });

      workingBalance = newBalance;
    }

    let movedTotal = new Big(0);

    if (diffBig.gt(0)) {
      // Sobrante: dos TRANSFER_OUT separados (principal + ajuste).
      const principalBig = systemBalanceBig.minus(baseBig).round(2);
      const adjustmentBig = diffBig;

      if (principalBig.gt(0)) {
        const principal = await this.executeCashTransferOut({
          manager,
          companyId,
          cashRegisterId,
          sourceCurrentBalance: workingBalance,
          target,
          amountBig: principalBig,
          actor,
          sourceLabel,
          idempotencyKey,
        });
        workingBalance = principal.newSourceBalance;
        movedTotal = movedTotal.plus(principalBig);
      }

      if (adjustmentBig.gt(0)) {
        const adjustment = await this.executeCashTransferOut({
          manager,
          companyId,
          cashRegisterId,
          sourceCurrentBalance: workingBalance,
          target,
          amountBig: adjustmentBig,
          actor,
          sourceLabel,
          logDescription: 'Traslado por sobrante a destino',
          financialDescription: 'Ajuste por sobrante trasladado al destino',
          idempotencyKey,
        });
        workingBalance = adjustment.newSourceBalance;
        movedTotal = movedTotal.plus(adjustmentBig);
      }
    } else if (totalOutflowBig.gt(0)) {
      // Cuadre o faltante: un único TRANSFER_OUT por (counted - base).
      const single = await this.executeCashTransferOut({
        manager,
        companyId,
        cashRegisterId,
        sourceCurrentBalance: workingBalance,
        target,
        amountBig: totalOutflowBig,
        actor,
        sourceLabel,
        idempotencyKey,
      });
      workingBalance = single.newSourceBalance;
      movedTotal = movedTotal.plus(totalOutflowBig);
    }

    return {
      moved_amount: preciseNumber(movedTotal, 2),
      difference: preciseNumber(diffBig, 2),
      new_balance: workingBalance,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helper compartido: ejecuta UN TRANSFER_OUT atómico hacia bank|wallet
  // ──────────────────────────────────────────────────────────────────────────

  private async executeCashTransferOut(
    params: ExecuteTransferOutParams,
  ): Promise<ExecuteTransferOutResult> {
    const {
      manager,
      companyId,
      cashRegisterId,
      sourceCurrentBalance,
      target,
      amountBig,
      actor,
      logDescription,
      financialDescription,
      idempotencyKey,
    } = params;

    const currentBalanceBig = toBig(sourceCurrentBalance);
    if (currentBalanceBig.lt(amountBig)) {
      throw new UnprocessableEntityException({
        message: `Saldo insuficiente en caja. Disponible: ${currentBalanceBig.toFixed(2)}`,
        payload: { code: 'INSUFFICIENT_BALANCE' },
      });
    }

    const destination = await this.loadDestination(
      manager,
      target.destinationType,
      target.destinationId,
      companyId,
    );

    const newCashBalance = preciseNumber(currentBalanceBig.minus(amountBig), 2);
    const amount = preciseNumber(amountBig, 2);

    await manager.update(
      CashRegister,
      { id: String(cashRegisterId), company_id: String(companyId) },
      { balance: newCashBalance },
    );

    await manager.getRepository(CashRegisterLog).save({
      company_id: String(companyId),
      cash_register_id: String(cashRegisterId),
      type: CashRegisterLogType.CASH_TRANSFER_OUT,
      direction: 'OUT',
      amount,
      affects_balance: true,
      description: logDescription ?? `Traslado a ${destination.name}`,
      created_by: actor.fullName,
      created_by_id: String(actor.id),
    });

    const newDestBalance = preciseNumber(toBig(destination.balance).plus(amountBig), 2);
    await this.setDestinationBalance(
      manager,
      target.destinationType,
      destination.id,
      companyId,
      newDestBalance,
    );

    const destinationAccountRef: AccountReference = target.destinationType;
    const referenceCode = this.buildReferenceCode('TRF', idempotencyKey ?? null);

    await this.financialMovementsService.record(manager, {
      companyId,
      amount,
      movement_type: MovementType.TRANSFER,
      concept: MovementConcept.TRANSFER,
      description: financialDescription ?? `Traslado de efectivo a ${destination.name}`,
      source_type: 'cash_register',
      source_id: cashRegisterId,
      destination_type: destinationAccountRef,
      destination_id: destination.id,
      reference_code: referenceCode,
      created_by: actor.fullName,
      created_by_id: actor.id,
    });

    return { destinationName: destination.name, newSourceBalance: newCashBalance };
  }

  private async loadDestination(
    manager: EntityManager,
    type: ResolvedDestination,
    id: number,
    companyId: number,
  ): Promise<{ id: number; name: string; balance: number }> {
    if (type === 'wallet') {
      const wallet = await manager.findOne(Wallet, {
        where: {
          id: String(id),
          company_id: String(companyId),
          is_archived: false,
        },
        select: { id: true, name: true, balance: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) {
        throw new NotFoundException('Wallet destino no encontrado');
      }
      return { id: Number(wallet.id), name: wallet.name, balance: Number(wallet.balance) };
    }
    const bank = await manager.findOne(Bank, {
      where: {
        id: String(id),
        company_id: String(companyId),
        is_archived: false,
      },
      select: { id: true, name: true, balance: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!bank) {
      throw new NotFoundException('Banco destino no encontrado');
    }
    return { id: Number(bank.id), name: bank.name, balance: Number(bank.balance) };
  }

  private async setDestinationBalance(
    manager: EntityManager,
    type: ResolvedDestination,
    id: number,
    companyId: number,
    newBalance: number,
  ): Promise<void> {
    if (type === 'wallet') {
      await manager.update(
        Wallet,
        { id: String(id), company_id: String(companyId) },
        { balance: newBalance },
      );
      return;
    }
    await manager.update(
      Bank,
      { id: String(id), company_id: String(companyId) },
      { balance: newBalance },
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Idempotencia
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Construye el `reference_code` para un `FinancialMovement` del cierre. Si
   * llega `idempotencyKey`, el código incluye `POS-CC-IDEMP-<key>-` como
   * prefijo para que `tryReplayIdempotent` lo encuentre. Si no, mantiene el
   * formato original `POS-CC-<tag>-<rand>`.
   *
   * `tag` es `OVR` (sobrante), `SHT` (faltante) o `TRF` (transferencia al
   * destino). Cada cierre puede emitir 1..3 FMs — el fast-path lee todos los
   * que comparten el prefijo IDEMP.
   */
  private buildReferenceCode(tag: 'OVR' | 'SHT' | 'TRF', idempotencyKey: string | null): string {
    const rand = randomUUID();
    if (idempotencyKey) {
      return `POS-CC-IDEMP-${idempotencyKey}-${tag}-${rand}`;
    }
    return `POS-CC-${tag}-${rand}`;
  }

  /**
   * Fast-path idempotente. Busca FMs persistidos con
   * `reference_code LIKE 'POS-CC-IDEMP-<key>-%'` para la company del actor.
   * Si encuentra al menos uno → reconstruye el resultado:
   *
   *   - `moved_amount` = Σ(amount) de los FMs con tag `TRF`.
   *   - `difference`   = Σ(amount) de los `OVR` − Σ(amount) de los `SHT`.
   *   - `new_balance`  = balance ACTUAL de la caja del actor (no es snapshot —
   *     ver limitación en JSDoc de la clase).
   *
   * Si no encuentra FMs con esa key → devuelve `null` y el caller ejecuta el
   * flujo normal.
   *
   * Defensa multi-tenant: la query filtra por `company_id` siempre. Aunque el
   * key fuera adivinado por un atacante en otra company, su búsqueda en la
   * SUYA devolvería 0 filas.
   */
  private async tryReplayIdempotent(
    companyId: number,
    actorId: number,
    idempotencyKey: string,
  ): Promise<CloseCashResult | null> {
    const fmRepo = this.dataSource.getRepository(FinancialMovement);
    const prefix = `POS-CC-IDEMP-${idempotencyKey}-`;
    const prior = await fmRepo.find({
      where: {
        company_id: String(companyId),
        reference_code: Like(`${prefix}%`),
      },
      select: { amount: true, reference_code: true },
    });
    if (prior.length === 0) {
      return null;
    }

    let moved = new Big(0);
    let diff = new Big(0);
    for (const fm of prior) {
      const tag = (fm.reference_code ?? '').slice(prefix.length).split('-')[0];
      const amt = toBig(fm.amount);
      if (tag === 'TRF') {
        moved = moved.plus(amt);
      } else if (tag === 'OVR') {
        diff = diff.plus(amt);
      } else if (tag === 'SHT') {
        diff = diff.minus(amt);
      }
    }

    // Re-leer la caja del actor para devolver new_balance. Sin lock — es un
    // SELECT informativo: el balance puede haber sido alterado por cobros
    // posteriores y eso es esperado (documentado en el JSDoc de la clase).
    const register = await this.dataSource.getRepository(CashRegister).findOne({
      where: { company_id: String(companyId), user_id: String(actorId) },
      select: { balance: true },
    });
    const newBalance = register ? Number(register.balance) : 0;

    return {
      message: 'Cierre de caja completado exitosamente',
      moved_amount: preciseNumber(moved, 2),
      difference: preciseNumber(diff, 2),
      new_balance: newBalance,
    };
  }
}

/**
 * Re-export del tipo para que el controller lo importe sin pegarse al action.
 */
export type CloseCashDestination = PosDataDestinationType;
