import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

/**
 * Valida el par (PRINCIPAL origen, SUCURSAL destino) para operaciones
 * cross-company del owner (clonar / compartir). Mismo patrón anti-IDOR que
 * `SwitchBranchAction`:
 *
 *   - El ORIGEN (`sourceCompanyId`, del JWT) DEBE ser el negocio principal
 *     (`is_branch = false`). Si es sucursal → 400.
 *   - El DESTINO (`branchCompanyId`, de la URL) DEBE ser una sucursal
 *     (`is_branch = true`) de la que el owner es MIEMBRO (`company_members`).
 *     Sin membresía → 403 genérico (no se filtra si existe). Miembro pero no
 *     sucursal → 400.
 */
export async function assertSourceAndBranch(
  runner: DataSource | EntityManager,
  sourceCompanyId: number,
  branchCompanyId: number,
  userId: number,
): Promise<void> {
  if (sourceCompanyId === branchCompanyId) {
    throw new BadRequestException('El origen y el destino no pueden ser la misma company.');
  }

  const source = await runner.query<Array<{ is_branch: boolean }>>(
    `SELECT is_branch FROM companies WHERE id = $1`,
    [String(sourceCompanyId)],
  );
  if (source.length === 0) {
    throw new BadRequestException('Company de origen no encontrada.');
  }
  if (source[0].is_branch === true) {
    throw new BadRequestException('La operación solo se permite desde el negocio principal.');
  }

  const membership = await runner.query<Array<{ is_branch: boolean }>>(
    `SELECT c.is_branch
     FROM company_members cm
     JOIN companies c ON c.id = cm.company_id
     WHERE cm.user_id = $1 AND cm.company_id = $2`,
    [String(userId), String(branchCompanyId)],
  );
  if (membership.length === 0) {
    throw new ForbiddenException('No tienes acceso a esa sucursal.');
  }
  if (membership[0].is_branch !== true) {
    throw new BadRequestException('El destino debe ser una sucursal.');
  }
}
