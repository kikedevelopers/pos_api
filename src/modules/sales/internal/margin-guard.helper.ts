import { UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { AppSetting, APP_SETTING_KEYS } from '@/modules/app-settings/entities/app-setting.entity';

/**
 * Roles del actor (User u Employee) que pueden saltar el margen mínimo.
 *
 * PlacePos permite override solo a `owner` o `superadmin`. Cualquier otro
 * `userType` (manager, employee, undefined) ve la regla aplicada.
 */
const OVERRIDE_ROLES: ReadonlySet<string> = new Set(['owner', 'superadmin']);

/**
 * Input de la verificación. `total` y `cost` son los totales consolidados
 * (ya con NC/ND aplicadas cuando se evalúa en editSale).
 */
export interface AssertMarginInput {
  manager: EntityManager;
  companyId: number;
  total: number | string;
  cost: number | string;
  /** Override solicitado por el cliente. Solo se aplica si `userType` lo permite. */
  overrideMargin?: boolean;
  userType?: string | null;
  /** Prefijo del mensaje de error. Default 'El margen de la venta'. */
  messagePrefix?: string;
}

/**
 * Lee y parsea las claves `pos_margins_enabled` y `pos_margins` del
 * `app_settings` de la company. Estructura PlacePos:
 *
 *   - `pos_margins_enabled`: `'true' | 'false'` (string).
 *   - `pos_margins`: JSON array de números (ej. `'[20, 30]'`). El primero es
 *     el mínimo permitido.
 */
async function loadMarginConfig(
  manager: EntityManager,
  companyId: number,
): Promise<{ enabled: boolean; minimum: number | null }> {
  const rows = await manager.find(AppSetting, {
    where: { company_id: String(companyId) },
    select: { id: true, key: true, value: true },
  });

  let enabled = false;
  let margins: number[] = [];
  for (const r of rows) {
    if (r.key === APP_SETTING_KEYS.POS_MARGINS_ENABLED) {
      enabled = String(r.value).toLowerCase() === 'true';
    } else if (r.key === APP_SETTING_KEYS.POS_MARGINS) {
      try {
        const parsed = JSON.parse(r.value) as unknown;
        if (Array.isArray(parsed)) {
          margins = parsed
            .map((v) => Number(v))
            .filter((n) => Number.isFinite(n) && !Number.isNaN(n));
        }
      } catch {
        margins = [];
      }
    }
  }

  if (!enabled || margins.length === 0) {
    return { enabled: false, minimum: null };
  }
  return { enabled: true, minimum: margins[0] };
}

/**
 * Verifica que el margen `(total - cost) / total * 100` sea >= mínimo
 * configurado. Espejo de `placepos/src/main/server/services/marginGuard.ts`.
 *
 * Reglas:
 *   - Si la regla está deshabilitada o no hay márgenes configurados → pasa.
 *   - Si `margin >= minimum` → pasa.
 *   - Si `overrideMargin === true` Y el actor es owner/superadmin → pasa
 *     (registrar en log el override es responsabilidad del caller).
 *   - Sino → lanza `UnprocessableEntityException` con
 *     `payload.code = 'MARGIN_BELOW_MIN'`. El message incluye el margen
 *     calculado y el mínimo permitido.
 */
export async function assertMarginAboveMinimum(input: AssertMarginInput): Promise<void> {
  const { manager, companyId, overrideMargin, userType, messagePrefix } = input;
  const config = await loadMarginConfig(manager, companyId);
  if (!config.enabled || config.minimum === null) {
    return;
  }

  const totalBig = toBig(input.total);
  if (totalBig.lte(0)) {
    return;
  } // venta sin importe: nada que validar.

  const costBig = toBig(input.cost);
  const profitBig = totalBig.minus(costBig);
  const marginBig = profitBig.div(totalBig).times(100);
  const margin = Number(marginBig.toFixed(2));

  if (margin >= config.minimum) {
    return;
  }

  // Override permitido SOLO para roles privilegiados. El caller marca
  // `overrideMargin=true` cuando el operador pulsó "Autorizar margen bajo"
  // en la UI; aún así el rol manda.
  if (overrideMargin === true && userType && OVERRIDE_ROLES.has(userType)) {
    return;
  }

  const prefix = messagePrefix ?? 'El margen de la venta';
  throw new UnprocessableEntityException({
    message: `${prefix} (${margin}%) está por debajo del mínimo permitido (${config.minimum}%)`,
    payload: { code: 'MARGIN_BELOW_MIN', margin, minimum: config.minimum },
  });
}
