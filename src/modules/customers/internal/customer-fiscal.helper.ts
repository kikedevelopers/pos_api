import type { CreateCustomerDto } from '../dto/create-customer.dto';
import type { UpdateCustomerDto } from '../dto/update-customer.dto';
import type { Customer } from '../entities/customer.entity';

/**
 * Campos de identidad fiscal (Facturación Electrónica) del cliente. Centralizado
 * aquí para que create/update los traten idéntico y para tener un único punto de
 * verdad de "qué cuenta como dato fiscal" (usado por el gate de FE).
 */
const FISCAL_INT_KEYS = [
  'type_document_identification_id',
  'type_regime_id',
  'type_liability_id',
  'municipality_id',
] as const;

type FiscalDto = CreateCustomerDto | UpdateCustomerDto;

/** Subconjunto fiscal de la entidad que create/update escriben. */
type FiscalColumns = Pick<
  Customer,
  | 'type_document_identification_id'
  | 'dv'
  | 'type_regime_id'
  | 'type_liability_id'
  | 'municipality_id'
  | 'merchant_registration'
>;

/** Normaliza un texto opcional: trim y vacío → null. */
function normalizeText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * ¿El DTO trae ALGÚN dato fiscal con valor (no null/undefined)? Se usa para
 * disparar el gate de FE solo cuando el usuario realmente asigna identidad
 * fiscal. Limpiar campos (enviar null) no cuenta: no es una operación de FE.
 */
export function hasAnyFiscalField(dto: FiscalDto): boolean {
  for (const key of FISCAL_INT_KEYS) {
    if (dto[key] != null) {
      return true;
    }
  }
  return normalizeText(dto.dv) !== null || normalizeText(dto.merchant_registration) !== null;
}

/**
 * Extrae los 6 campos fiscales para el CREATE: cada uno presente y normalizado
 * (ausente → null). Se hace explícito para que el INSERT deje NULL sin ambigüedad.
 */
export function extractFiscalFields(dto: CreateCustomerDto): FiscalColumns {
  return {
    type_document_identification_id: dto.type_document_identification_id ?? null,
    dv: normalizeText(dto.dv),
    type_regime_id: dto.type_regime_id ?? null,
    type_liability_id: dto.type_liability_id ?? null,
    municipality_id: dto.municipality_id ?? null,
    merchant_registration: normalizeText(dto.merchant_registration),
  };
}

/**
 * Construye el PATCH fiscal para el UPDATE: solo las claves DEFINIDAS en el DTO
 * (para no nullificar lo no enviado). Un `null` explícito sí se respeta — el
 * usuario puede limpiar un campo fiscal.
 */
export function buildFiscalPatch(dto: UpdateCustomerDto): Partial<FiscalColumns> {
  const patch: Partial<FiscalColumns> = {};
  for (const key of FISCAL_INT_KEYS) {
    if (dto[key] !== undefined) {
      patch[key] = dto[key] ?? null;
    }
  }
  if (dto.dv !== undefined) {
    patch.dv = normalizeText(dto.dv);
  }
  if (dto.merchant_registration !== undefined) {
    patch.merchant_registration = normalizeText(dto.merchant_registration);
  }
  return patch;
}
