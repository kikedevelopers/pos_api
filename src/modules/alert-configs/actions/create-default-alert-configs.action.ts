import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { AlertConfig } from '../entities/alert-config.entity';

export interface DefaultAlertConfigsCreator {
  id: number;
  fullName: string;
}

export interface CreateDefaultAlertConfigsInput {
  companyId: number;
  /** Reservado por simetría con otros seeds. No se persiste en `alert_configs`. */
  createdBy: DefaultAlertConfigsCreator;
}

/**
 * Configuración por defecto para `INACTIVE_CUSTOMER`. Espejo del seed
 * `placepos/src/main/database/seeds/alertConfigs.ts`:
 *
 *   - `is_enabled = false`  → el dueño la activa cuando quiera empezar a
 *     recibir el resumen diario de clientes inactivos.
 *   - `check_time = '07:00:00'` → hora en que el scheduler dispara la
 *     evaluación (placepos lo persiste en su propia columna; pos_api lo
 *     guarda dentro del jsonb `config` porque la entidad no tiene esa
 *     columna — el evaluator de Fase 11 lo leerá de ahí).
 *   - `params`: { inactivity_days: 15, min_purchases: 3,
 *                 recurrence_window_days: 60 }.
 */
const DEFAULT_ALERT_CONFIGS: Array<{
  type: string;
  enabled: boolean;
  threshold: number | null;
  config: Record<string, unknown>;
}> = [
  {
    type: 'INACTIVE_CUSTOMER',
    enabled: false,
    threshold: null,
    config: {
      check_time: '07:00:00',
      inactivity_days: 15,
      min_purchases: 3,
      recurrence_window_days: 60,
    },
  },
];

/**
 * Crea las alert configs por defecto al registrar una company nueva.
 *
 * Idempotencia: el UNIQUE `(company_id, type)` previene duplicados — si por
 * cualquier motivo `RegisterAction` se ejecutara dos veces, el segundo
 * INSERT explotaría con 23505 y haría rollback de toda la transacción
 * (comportamiento deseado: el registro tiene que ser atómico una sola vez).
 *
 * Cómo cablearlo en `RegisterAction`:
 *
 *   1. Añadir `AlertConfigsModule` a `AuthModule.imports`.
 *   2. Inyectarlo en el constructor de `RegisterAction`.
 *   3. Llamarlo DENTRO de la transacción del registro, junto a los otros
 *      seeds:
 *        await this.createDefaultAlertConfigsAction.execute(manager, {
 *          companyId,
 *          createdBy,
 *        });
 */
@Injectable()
export class CreateDefaultAlertConfigsAction {
  async execute(
    manager: EntityManager,
    input: CreateDefaultAlertConfigsInput,
  ): Promise<AlertConfig[]> {
    const repo = manager.getRepository(AlertConfig);

    const rows = DEFAULT_ALERT_CONFIGS.map((cfg) =>
      repo.create({
        company_id: String(input.companyId),
        type: cfg.type,
        enabled: cfg.enabled,
        threshold: cfg.threshold,
        config: cfg.config,
      }),
    );

    return repo.save(rows);
  }
}
