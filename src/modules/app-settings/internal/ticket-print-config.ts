import type { EntityManager } from 'typeorm';

import { APP_SETTING_KEYS, AppSetting } from '../entities/app-setting.entity';

/**
 * Configuración de impresión del ticket de venta: espacios en blanco para
 * diligenciar A MANO (observaciones y firma) en el ticket térmico.
 *
 * Cada espacio se configura por separado con 2 keys en `app_settings`
 * (per-company):
 *   - `ticket_<space>_space_enabled`       (`'true'` | `'false'`). Default false:
 *     si la fila no existe, el ticket se imprime como siempre.
 *   - `ticket_<space>_space_ticket_types`  JSON array con los tipos de ticket
 *     donde aparece. Default: TODOS. Un valor ausente, corrupto o vacío cae al
 *     default (nunca deja un espacio activo que no sale en ningún ticket).
 *
 * Tipos de ticket (los decide el cliente al imprimir):
 *   - `SALE`   venta pagada (sin crédito).
 *   - `ORDER`  pedido por cobrar.
 *   - `CREDIT` venta a crédito.
 */
export const TICKET_PRINT_TICKET_TYPES = ['SALE', 'ORDER', 'CREDIT'] as const;
export type TicketPrintTicketType = (typeof TICKET_PRINT_TICKET_TYPES)[number];

export interface TicketPrintConfig {
  observations_enabled: boolean;
  observations_ticket_types: TicketPrintTicketType[];
  signature_enabled: boolean;
  signature_ticket_types: TicketPrintTicketType[];
}

export type TicketPrintConfigPatch = Partial<TicketPrintConfig>;

type EnabledField = 'observations_enabled' | 'signature_enabled';
type TicketTypesField = 'observations_ticket_types' | 'signature_ticket_types';

const ENABLED_KEYS: Record<EnabledField, string> = {
  observations_enabled: APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_ENABLED,
  signature_enabled: APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_ENABLED,
};

const TICKET_TYPES_KEYS: Record<TicketTypesField, string> = {
  observations_ticket_types: APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_TICKET_TYPES,
  signature_ticket_types: APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_TICKET_TYPES,
};

const isTicketType = (value: unknown): value is TicketPrintTicketType =>
  typeof value === 'string' && (TICKET_PRINT_TICKET_TYPES as readonly string[]).includes(value);

/**
 * Deja solo tipos conocidos, sin duplicados y en orden canónico. Vacío ⇒ todos.
 */
export const normalizeTicketTypes = (values: unknown[]): TicketPrintTicketType[] => {
  const selected = TICKET_PRINT_TICKET_TYPES.filter((type) =>
    values.some((value) => isTicketType(value) && value === type),
  );
  return selected.length > 0 ? selected : [...TICKET_PRINT_TICKET_TYPES];
};

const parseTicketTypes = (raw: string | undefined): TicketPrintTicketType[] => {
  if (raw === undefined) {
    return [...TICKET_PRINT_TICKET_TYPES];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeTicketTypes(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [...TICKET_PRINT_TICKET_TYPES];
  }
};

export const getTicketPrintConfig = async (
  manager: EntityManager,
  companyId: number,
): Promise<TicketPrintConfig> => {
  const repo = manager.getRepository(AppSetting);
  const company_id = String(companyId);
  const find_value = async (key: string): Promise<string | undefined> =>
    (await repo.findOne({ where: { company_id, key } }))?.value;

  const [
    observations_enabled,
    observations_ticket_types,
    signature_enabled,
    signature_ticket_types,
  ] = await Promise.all([
    find_value(ENABLED_KEYS.observations_enabled),
    find_value(TICKET_TYPES_KEYS.observations_ticket_types),
    find_value(ENABLED_KEYS.signature_enabled),
    find_value(TICKET_TYPES_KEYS.signature_ticket_types),
  ]);

  return {
    observations_enabled: observations_enabled === 'true',
    observations_ticket_types: parseTicketTypes(observations_ticket_types),
    signature_enabled: signature_enabled === 'true',
    signature_ticket_types: parseTicketTypes(signature_ticket_types),
  };
};

/**
 * Upsert PARCIAL: solo persiste los campos presentes en el patch. Así cada
 * control de la UI guarda su propia key y dos cambios casi simultáneos no se
 * pisan entre sí. Upsert por `(company_id, key)` — el índice único de
 * `app_settings` garantiza una sola fila por (tenant, key).
 */
export const setTicketPrintConfig = async (
  manager: EntityManager,
  companyId: number,
  patch: TicketPrintConfigPatch,
): Promise<void> => {
  const company_id = String(companyId);
  const rows: { company_id: string; key: string; value: string }[] = [];

  for (const field of Object.keys(ENABLED_KEYS) as EnabledField[]) {
    const value = patch[field];
    if (typeof value === 'boolean') {
      rows.push({ company_id, key: ENABLED_KEYS[field], value: value ? 'true' : 'false' });
    }
  }
  for (const field of Object.keys(TICKET_TYPES_KEYS) as TicketTypesField[]) {
    const value = patch[field];
    if (Array.isArray(value)) {
      rows.push({
        company_id,
        key: TICKET_TYPES_KEYS[field],
        value: JSON.stringify(normalizeTicketTypes(value)),
      });
    }
  }

  if (rows.length === 0) {
    return;
  }
  await manager.getRepository(AppSetting).upsert(rows, ['company_id', 'key']);
};
