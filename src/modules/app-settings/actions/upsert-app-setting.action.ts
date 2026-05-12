import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';
import { PG_UNIQUE_VIOLATION } from '../internal/constraint-errors';

/**
 * Conjunto de claves conocidas que el endpoint acepta. MED-3 auditoría: sin
 * lista blanca, un cliente buggy o malicioso puede polinizar la tabla con
 * miles de keys aleatorias (DoS de storage). Se valida en pre-flight del
 * upsert.
 */
const ALLOWED_KEYS = new Set<string>(Object.values(APP_SETTING_KEYS));

/**
 * Upsert (set value) de un `app_setting` per-company.
 *
 * Endpoint `PUT /app-settings/:key`.
 *
 * Espejo del comportamiento PlacePos (`repo.upsert({ key, value }, ['key'])`)
 * adaptado a UNIQUE compuesto `(company_id, key)`:
 *
 *   1. Buscar existing por (company_id, key).
 *   2. Si existe → UPDATE.
 *   3. Si no existe → INSERT. Si dos requests concurrentes ganaron la carrera
 *      del SELECT y ambas intentan INSERT, una pasa y la otra recibe
 *      `unique_violation (23505)` → reintenta como UPDATE.
 *
 * Toda la operación corre en una transacción para que la combinación
 * SELECT → INSERT/UPDATE sea visible atómicamente al resto.
 */
@Injectable()
export class UpsertAppSettingAction {
  constructor(private readonly dataSource: DataSource) {}

  async execute(key: string, value: string, companyId: number): Promise<AppSetting> {
    // MED-3 auditoría: whitelist de keys conocidas. Si el cliente envía una
    // key no registrada en `APP_SETTING_KEYS`, rechazamos con 400. Para
    // añadir una key nueva, primero se actualiza la constante y se reinicia
    // el API — esto previene pollution de la tabla por bug del cliente.
    if (!ALLOWED_KEYS.has(key)) {
      throw new BadRequestException(`Key "${key}" no soportada`);
    }

    return this.dataSource.transaction<AppSetting>(async (manager) => {
      const existing = await manager.findOne(AppSetting, {
        where: { company_id: String(companyId), key },
      });

      if (existing) {
        await manager.update(
          AppSetting,
          { id: existing.id, company_id: String(companyId) },
          { value },
        );
        return manager.findOneOrFail(AppSetting, {
          where: { id: existing.id, company_id: String(companyId) },
        });
      }

      // No existía → INSERT. Si pierde la race contra otro upsert, retry
      // como UPDATE (la otra request ya creó la row).
      try {
        await manager.insert(AppSetting, {
          company_id: String(companyId),
          key,
          value,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          await manager.update(AppSetting, { company_id: String(companyId), key }, { value });
        } else {
          throw error;
        }
      }

      return manager.findOneOrFail(AppSetting, {
        where: { company_id: String(companyId), key },
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
