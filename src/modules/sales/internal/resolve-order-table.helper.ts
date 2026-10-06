import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { resolvePosMode } from '@/common/pos-mode/pos-mode.util';
import { Company } from '@/modules/companies/entities/company.entity';
import { RestaurantTable } from '@/modules/restaurant-tables/entities/restaurant-table.entity';
import { Salon } from '@/modules/salons/entities/salon.entity';

export interface OrderTableResult {
  tableId: string;
  salonId: string | null;
  tableName: string;
  salonName: string | null;
}

/**
 * Valida la mesa de un pedido (botón "Enviar a" del POS de restaurantes) y la
 * marca OCUPADA, todo dentro de la transacción del create de la venta.
 *
 * Defensa REAL contra ocupar una mesa ya ocupada (aunque el cliente la viera
 * libre por falta de refresco): toma un lock `pessimistic_write` sobre la fila
 * de la mesa y rechaza con 409 si ya está ocupada. Dos pedidos concurrentes a
 * la misma mesa se serializan y el segundo falla.
 *
 * Reglas:
 *   - Solo en modo restaurante (422 si la company no lo es).
 *   - La mesa debe existir, ser de la company y no estar archivada (422).
 *   - La mesa debe estar libre (409 `TABLE_OCCUPIED` si ocupada).
 *   - Si se indica `salonId`, la mesa debe pertenecer a ese salón (422).
 */
export async function resolveAndOccupyOrderTable(
  manager: EntityManager,
  companyId: number,
  tableId: number,
  salonId: number | null,
): Promise<OrderTableResult> {
  const company = await manager.findOne(Company, {
    where: { id: String(companyId) },
    select: { id: true, pos_mode: true },
  });
  if (resolvePosMode(company?.pos_mode) !== 'restaurant') {
    throw new UnprocessableEntityException(
      'Las mesas solo están disponibles en el modo restaurante',
    );
  }

  const table = await manager.findOne(RestaurantTable, {
    where: { id: String(tableId), company_id: String(companyId), is_archived: false },
    lock: { mode: 'pessimistic_write' },
  });
  if (!table) {
    throw new UnprocessableEntityException('La mesa no existe o está archivada');
  }
  if (table.status === 'occupied') {
    throw new ConflictException({
      message: 'La mesa ya está ocupada por otro pedido.',
      payload: { code: 'TABLE_OCCUPIED' },
    });
  }

  let salonIdStr: string | null = null;
  let salonName: string | null = null;
  if (salonId !== null && salonId !== undefined) {
    if (table.salon_id !== String(salonId)) {
      throw new UnprocessableEntityException('La mesa no pertenece al salón indicado');
    }
    const salon = await manager.findOne(Salon, {
      where: { id: String(salonId), company_id: String(companyId), is_archived: false },
    });
    if (!salon) {
      throw new UnprocessableEntityException('El salón no existe o está archivado');
    }
    salonIdStr = salon.id;
    salonName = salon.name;
  }

  await manager.update(
    RestaurantTable,
    { id: table.id, company_id: String(companyId) },
    { status: 'occupied' },
  );

  return { tableId: table.id, salonId: salonIdStr, tableName: table.name, salonName };
}

/**
 * Libera la mesa de un pedido (al cobrarlo o anularlo). Idempotente y seguro si
 * el pedido no tenía mesa (`tableId` null → no hace nada).
 */
export async function freeOrderTable(
  manager: EntityManager,
  companyId: number,
  tableId: string | null,
): Promise<void> {
  if (!tableId) {
    return;
  }
  await manager.update(
    RestaurantTable,
    { id: tableId, company_id: String(companyId) },
    { status: 'free' },
  );
}
