import { In, Like, Not, type FindOptionsWhere } from 'typeorm';

import type { AppAlert } from '../entities/app-alert.entity';
import { AGENT_ORDER_ALERT_PREFIX } from './alert-visibility';

/**
 * Qué alertas ve un usuario:
 *   - Las de su negocio ACTIVO (menos los tipos ocultos para su nivel).
 *   - Si es dueño con sucursales, además las de pedidos del agente
 *     (`AGENT_ORDER_*`) de sus OTROS negocios activos: un pedido en la sucursal
 *     X le llega aunque esté parado en el principal o en la sucursal Y.
 *   Las demás alertas de otros negocios (gastos fijos...) no: son de su negocio.
 */
export interface AlertScope {
  companyId: number;
  /** Prefijo de tipos ocultos en el negocio activo (`null` = ve todo). */
  hiddenTypePrefix: string | null;
  /** Otros negocios del dueño de los que ve los pedidos del agente. */
  agentCompanyIds: number[];
}

/** Alcance de un solo negocio (sin sucursales). */
export const singleCompanyScope = (
  companyId: number,
  hiddenTypePrefix: string | null = null,
): AlertScope => ({ companyId, hiddenTypePrefix, agentCompanyIds: [] });

/**
 * Condiciones (OR) del alcance, cada una combinada con `extra` (no leídas,
 * fecha...). Para `find`/`count` de TypeORM, un arreglo es un OR.
 */
export const scopeWhere = (
  scope: AlertScope,
  extra: FindOptionsWhere<AppAlert> = {},
): FindOptionsWhere<AppAlert>[] => {
  const own: FindOptionsWhere<AppAlert> = {
    company_id: String(scope.companyId),
    ...(scope.hiddenTypePrefix ? { type: Not(Like(`${scope.hiddenTypePrefix}%`)) } : {}),
    ...extra,
  };
  const others = [...new Set(scope.agentCompanyIds)].filter((id) => id !== scope.companyId);
  if (others.length === 0) {
    return [own];
  }
  return [
    own,
    {
      company_id: In(others.map(String)),
      type: Like(`${AGENT_ORDER_ALERT_PREFIX}%`),
      ...extra,
    },
  ];
};
