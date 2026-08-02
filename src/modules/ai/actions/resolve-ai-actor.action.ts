import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

import type { AiToolActor } from '../internal/tool-catalog';

/** Todo lo que el asistente necesita saber de quién pregunta. */
export interface AiActorContext extends AiToolActor {
  companyId: number;
  /** Nombre de pila, para saludar y personalizar. */
  userName: string;
  /** Rol legible en español. */
  userRole: string;
  businessName: string;
}

const ROLE_LABELS: Record<string, string> = {
  superadmin: 'administrador del sistema',
  owner: 'dueño del negocio',
  manager: 'administrador',
  employee: 'empleado',
};

/**
 * Resuelve permisos efectivos, visibilidad de ganancias y datos de contexto
 * (negocio y usuario) del actor autenticado.
 *
 * La visibilidad de ganancias replica la regla del cliente: owner/superadmin
 * siempre pueden; el empleado depende de su flag `can_view_profit`.
 */
@Injectable()
export class ResolveAiActorAction {
  constructor(
    private readonly dataSource: DataSource,
    private readonly resolvePermissions: ResolveEffectivePermissionsAction,
  ) {}

  async execute(user: AuthUser, companyId: number): Promise<AiActorContext> {
    const isAdmin = user.type === 'owner' || user.type === 'superadmin';

    const [permissions, businessName, canViewProfit] = await Promise.all([
      this.resolvePermissions.execute({
        type: user.type,
        account: user.account,
        user_id: user.user_id,
        company_id: companyId,
      }),
      this.fetchBusinessName(companyId),
      this.fetchCanViewProfit(user, companyId, isAdmin),
    ]);

    return {
      companyId,
      userId: user.user_id,
      isAdmin,
      permissions: new Set<string>(permissions),
      canViewProfit,
      userName: user.name?.trim() || 'Usuario',
      userRole: ROLE_LABELS[user.type] ?? 'usuario',
      businessName,
    };
  }

  private async fetchBusinessName(companyId: number): Promise<string> {
    const rows = await this.dataSource.query<Array<{ name: string | null }>>(
      'SELECT name FROM companies WHERE id = $1 LIMIT 1',
      [String(companyId)],
    );
    return rows[0]?.name?.trim() || 'Mi Negocio';
  }

  private async fetchCanViewProfit(
    user: AuthUser,
    companyId: number,
    isAdmin: boolean,
  ): Promise<boolean> {
    if (isAdmin) {
      return true;
    }
    if (user.account !== 'employee') {
      return false;
    }

    // El JWT del empleado lleva su `user_id` (la cuenta de acceso), no el id de
    // la fila `employees` — mismo lookup que `ResolveEffectivePermissionsAction`.
    const rows = await this.dataSource.query<Array<{ can_view_profit: boolean }>>(
      `SELECT can_view_profit FROM employees
       WHERE user_id = $1 AND company_id = $2 AND is_archived = false
       LIMIT 1`,
      [String(user.user_id), String(companyId)],
    );
    return rows[0]?.can_view_profit === true;
  }
}
