import Big from 'big.js';
import type { EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';

/**
 * Configuración del sistema de PUNTOS de cliente — espejo de
 * `placepos/src/main/server/services/customerPointsSettings.service.ts`.
 *
 * Persistida como 3 keys en `app_settings` (per-company):
 *   - `customer_points_enabled`    (`'true'` | `'false'`).
 *   - `customer_points_peso_base`  (X pesos por bloque, número positivo).
 *   - `customer_points_per_base`   (Y puntos por bloque, entero ≥ 1).
 *
 * Multi-tenant: TODA lectura/escritura filtra por `company_id`. Reutiliza el
 * mecanismo genérico clave-valor `app_settings` que PlacePos usa para flags
 * equivalentes (break-even/márgenes/inventario estricto).
 */
export interface CustomerPointsConfig {
  enabled: boolean;
  pesoBase: number;
  perBase: number;
}

const DEFAULT_CONFIG: CustomerPointsConfig = {
  enabled: false,
  pesoBase: 1000,
  perBase: 1,
};

/**
 * Parsea un número positivo desde el `value` textual del setting. Si la key no
 * existe o el valor es inválido (no finito o ≤ 0) cae al fallback — espejo del
 * `parsePositiveNumber` de PlacePos.
 */
const parsePositiveNumber = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return num;
};

/**
 * Lee la config de puntos de la company. Si alguna key falta, usa el default
 * (`enabled=false`, `pesoBase=1000`, `perBase=1`). Recibe el `EntityManager`
 * del caller para participar de su transacción (lo usa `recomputeSalePoints`).
 */
export const getCustomerPointsConfig = async (
  manager: EntityManager,
  companyId: number,
): Promise<CustomerPointsConfig> => {
  const repo = manager.getRepository(AppSetting);
  const company_id = String(companyId);
  const [enabledRow, pesoBaseRow, perBaseRow] = await Promise.all([
    repo.findOne({ where: { company_id, key: APP_SETTING_KEYS.CUSTOMER_POINTS_ENABLED } }),
    repo.findOne({ where: { company_id, key: APP_SETTING_KEYS.CUSTOMER_POINTS_PESO_BASE } }),
    repo.findOne({ where: { company_id, key: APP_SETTING_KEYS.CUSTOMER_POINTS_PER_BASE } }),
  ]);
  return {
    enabled: enabledRow?.value === 'true',
    pesoBase: parsePositiveNumber(pesoBaseRow?.value, DEFAULT_CONFIG.pesoBase),
    perBase: parsePositiveNumber(perBaseRow?.value, DEFAULT_CONFIG.perBase),
  };
};

/**
 * Upsert atómico de las 3 keys de la config de puntos para la company. Recibe
 * el `EntityManager` del caller (la acción que la cablea abre la transacción).
 *
 * Upsert por `(company_id, key)` — el índice único de `app_settings` garantiza
 * una sola row por (tenant, key).
 */
export const setCustomerPointsConfig = async (
  manager: EntityManager,
  companyId: number,
  cfg: CustomerPointsConfig,
): Promise<void> => {
  const repo = manager.getRepository(AppSetting);
  const company_id = String(companyId);
  await repo.upsert(
    [
      {
        company_id,
        key: APP_SETTING_KEYS.CUSTOMER_POINTS_ENABLED,
        value: cfg.enabled ? 'true' : 'false',
      },
      {
        company_id,
        key: APP_SETTING_KEYS.CUSTOMER_POINTS_PESO_BASE,
        value: String(cfg.pesoBase),
      },
      {
        company_id,
        key: APP_SETTING_KEYS.CUSTOMER_POINTS_PER_BASE,
        value: String(cfg.perBase),
      },
    ],
    ['company_id', 'key'],
  );
};

/**
 * `pointsForAmount(amount, cfg) = enabled ? floor(amount / pesoBase) * perBase : 0`,
 * retornado como ENTERO. Big.js para el divisor monetario (nunca floats crudos).
 * Espejo byte-por-byte de PlacePos.
 */
export const pointsForAmount = (amount: number, cfg: CustomerPointsConfig): number => {
  if (!cfg.enabled || cfg.pesoBase <= 0) {
    return 0;
  }
  const blocks = toBig(amount).div(cfg.pesoBase).round(0, Big.roundDown);
  return blocks.times(cfg.perBase).round(0, Big.roundDown).toNumber();
};
