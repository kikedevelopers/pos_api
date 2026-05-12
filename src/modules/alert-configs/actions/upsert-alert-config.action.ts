import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { UpsertAlertConfigDto } from '../dto/upsert-alert-config.dto';
import { AlertConfig } from '../entities/alert-config.entity';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Upsert de configuración de alerta. Endpoint `PUT /alert-configs/:type`.
 *
 * Espejo PlacePos `alert-configs.routes.ts`:
 *   - Si existe row para (company, type) → UPDATE.
 *   - Si no existe → INSERT con `type` del path param.
 *
 * Diferencias vs PlacePos local:
 *   - El scheduler `rescheduleAlertConfig` NO se invoca aquí — los jobs
 *     cloud se manejan en Fase 11 (background workers + cron).
 *   - El `paramValidators[type]` específico NO se aplica — los evaluators
 *     viven en Fase 11. En esta fase aceptamos `config` jsonb libre.
 *
 * Transacción: garantiza atomicidad del SELECT → INSERT/UPDATE.
 * Race contra otro upsert concurrente: retry como UPDATE si `23505`.
 */
@Injectable()
export class UpsertAlertConfigAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(type: string, dto: UpsertAlertConfigDto, companyId: number): Promise<AlertConfig> {
    // TypeORM espera `QueryDeepPartialEntity<AlertConfig>` para `update()`.
    // El campo `config` es jsonb (`Record<string, unknown>`) y TypeORM lo
    // expresa como `() => string | QueryDeepPartialEntity<...>` para soportar
    // expresiones SQL. Para un payload jsonb literal, casteamos al alias del
    // tipo público para que TS lo acepte sin perder la garantía estructural.
    const patch: QueryDeepPartialEntity<AlertConfig> = {
      enabled: dto.enabled,
      // `threshold` undefined ≠ null. Si no viene en el DTO, no lo seteamos
      // (preserva el valor existente al UPDATE). Si viene `null` explícito,
      // lo limpiamos.
      ...(Object.prototype.hasOwnProperty.call(dto, 'threshold')
        ? { threshold: dto.threshold ?? null }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(dto, 'config')
        ? {
            config: (dto.config ?? {}) as QueryDeepPartialEntity<AlertConfig>['config'],
          }
        : {}),
    };

    return this.dataSource.transaction<AlertConfig>(async (manager) => {
      const existing = await manager.findOne(AlertConfig, {
        where: { company_id: String(companyId), type },
      });

      if (existing) {
        await manager.update(
          AlertConfig,
          { id: existing.id, company_id: String(companyId) },
          patch,
        );
        return manager.findOneOrFail(AlertConfig, {
          where: { id: existing.id, company_id: String(companyId) },
        });
      }

      try {
        await manager.insert(AlertConfig, {
          company_id: String(companyId),
          type,
          enabled: patch.enabled ?? true,
          threshold: patch.threshold ?? null,
          config: patch.config ?? {},
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Race: otra request creó la row. Reintentamos como UPDATE.
          await manager.update(AlertConfig, { company_id: String(companyId), type }, patch);
        } else {
          throw error;
        }
      }

      return manager.findOneOrFail(AlertConfig, {
        where: { company_id: String(companyId), type },
      });
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const pgError = error as QueryFailedError & { code?: string };
  return pgError.code === PG_UNIQUE_VIOLATION;
}
