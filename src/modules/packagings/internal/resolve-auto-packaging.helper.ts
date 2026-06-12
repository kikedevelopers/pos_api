import { randomUUID } from 'node:crypto';

import type { EntityManager } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';

/**
 * Resuelve el `packaging_id` para presentaciones de peso/monto variable: busca
 * un empaque "auto" (`is_auto = true`) de la MISMA company con ese `value`; si
 * no existe lo crea. Devuelve el id (bigint como string). Se usa cuando el
 * producto llega con `packaging_value` pero sin `packaging_id`.
 *
 * Espejo de `resolveAutoPackagingId` en PlacePos, con scoping multi-tenant:
 *   - El empaque auto se crea con `company_id := companyId` (nunca del payload).
 *   - Comparte el `EntityManager` de la transacción del producto → atómico.
 *
 * El factor de conversión sigue viviendo en `packaging.value`, así que POS,
 * inventario, costos y compras funcionan sin cambios (el empaque auto es
 * indistinguible de uno manual salvo por `is_auto`, que solo afecta al
 * SELECTOR de empaques).
 */
export async function resolveAutoPackagingId(
  manager: EntityManager,
  rawValue: number,
  companyId: number,
  createdBy: { id: number; fullName: string },
): Promise<string> {
  // `value` se redondea a 2 decimales (igual que el cliente / PlacePos) para
  // que el find-or-create no genere empaques auto casi-duplicados.
  const value = preciseNumber(rawValue, 2);

  const repo = manager.getRepository(Packaging);
  const existing = await repo.findOne({
    where: {
      company_id: String(companyId),
      is_auto: true,
      is_archived: false,
      value,
    },
  });
  if (existing) return existing.id;

  const created = await repo.save(
    repo.create({
      company_id: String(companyId),
      // Nombre = UUID para evitar cualquier colisión con el índice único de
      // nombre por company. El usuario nunca lo ve: la UI muestra una etiqueta
      // genérica desde `is_auto`. La reutilización se hace por `value`, no por nombre.
      name: randomUUID(),
      value,
      is_auto: true,
      is_archived: false,
      created_by: createdBy.fullName,
      created_by_id: String(createdBy.id),
    }),
  );
  return created.id;
}
