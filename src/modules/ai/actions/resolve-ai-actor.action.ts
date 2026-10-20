import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { ResolveEffectivePermissionsAction } from '@/modules/roles/actions/resolve-effective-permissions.action';

import type { AiBusiness } from '../internal/business-scope';
import type { AiToolActor } from '../internal/tool-catalog';

/** Todo lo que el asistente necesita saber de quién pregunta. */
export interface AiActorContext extends AiToolActor {
  companyId: number;
  /** Nombre de pila, para saludar y personalizar. */
  userName: string;
  /** Nombre completo: firma (`created_by`) de los gastos que registre Place. */
  full_name: string;
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

    const [permissions, businessName, employee_flags, businesses] = await Promise.all([
      this.resolvePermissions.execute({
        type: user.type,
        account: user.account,
        user_id: user.user_id,
        company_id: companyId,
      }),
      this.fetchBusinessName(companyId),
      this.fetchEmployeeFlags(user, companyId, isAdmin),
      this.fetchOwnerBusinesses(user, companyId),
    ]);

    return {
      companyId,
      userId: user.user_id,
      isAdmin,
      permissions: new Set<string>(permissions),
      canViewProfit: employee_flags.can_view_profit,
      is_administrator: employee_flags.is_administrator,
      userName: user.name?.trim() || 'Usuario',
      full_name: `${user.name ?? ''} ${user.lastname ?? ''}`.trim() || 'Usuario',
      userRole: ROLE_LABELS[user.type] ?? 'usuario',
      businessName,
      // Owner sin membresías: solo el negocio actual (Place dirá que no tiene sucursales).
      businesses: businesses ?? [
        { id: companyId, name: businessName, is_branch: false, is_active: true },
      ],
    };
  }

  /**
   * Negocios del OWNER (principal primero, luego sucursales por id), de
   * `company_members` — la misma fuente que el selector de sucursal y los
   * informes consolidados. Sale del `user_id` del JWT, así que da lo mismo
   * desde qué negocio esté conectado.
   *
   * Solo el owner: un empleado o el superadmin reciben `[]` sin tocar la BD.
   * `null` = owner sin membresías válidas (cuenta antigua): el caller asume
   * solo el negocio actual.
   */
  private async fetchOwnerBusinesses(
    user: AuthUser,
    companyId: number,
  ): Promise<AiBusiness[] | null> {
    if (user.type !== 'owner') {
      return [];
    }
    const rows = await this.dataSource.query<
      Array<{ id: string; name: string | null; is_branch: boolean; is_active: boolean }>
    >(
      `SELECT c.id::text AS id, c.name, c.is_branch, cm.is_active
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
        WHERE cm.user_id = $1
        ORDER BY c.is_branch ASC, c.id ASC`,
      [String(user.user_id)],
    );
    const businesses = rows.map((row) => ({
      id: Number(row.id),
      name: row.name?.trim() || `Negocio #${row.id}`,
      is_branch: row.is_branch === true,
      is_active: row.is_active !== false,
    }));
    // Anti-IDOR: el negocio de la sesión tiene que ser suyo; si no aparece
    // (cuenta sin membresías), no se le abre ningún otro.
    if (!businesses.some((business) => business.id === companyId)) {
      return null;
    }
    return businesses;
  }

  private async fetchBusinessName(companyId: number): Promise<string> {
    const rows = await this.dataSource.query<Array<{ name: string | null }>>(
      'SELECT name FROM companies WHERE id = $1 LIMIT 1',
      [String(companyId)],
    );
    return rows[0]?.name?.trim() || 'Mi Negocio';
  }

  /**
   * Flags del empleado en UNA consulta:
   *   - `can_view_profit`: visibilidad de ganancias.
   *   - `is_administrator`: tiene el rol de fábrica "Administrador" — el único
   *     de sistema NO editable (`is_system AND NOT is_editable`), con acceso
   *     total inamovible. Un rol personalizado con todos los permisos NO
   *     cuenta: escribir desde Place es del owner o del Administrador.
   *
   * Owner/superadmin: ambos true sin tocar la BD.
   */
  private async fetchEmployeeFlags(
    user: AuthUser,
    companyId: number,
    isAdmin: boolean,
  ): Promise<{ can_view_profit: boolean; is_administrator: boolean }> {
    if (isAdmin) {
      return { can_view_profit: true, is_administrator: true };
    }
    if (user.account !== 'employee') {
      return { can_view_profit: false, is_administrator: false };
    }

    // El JWT del empleado lleva su `user_id` (la cuenta de acceso), no el id de
    // la fila `employees` — mismo lookup que `ResolveEffectivePermissionsAction`.
    const rows = await this.dataSource.query<
      Array<{ can_view_profit: boolean; is_administrator: boolean }>
    >(
      `SELECT e.can_view_profit,
              COALESCE(r.is_system AND NOT r.is_editable
                       AND lower(btrim(r.name)) = 'administrador', false) AS is_administrator
         FROM employees e
         LEFT JOIN roles r ON r.id = e.role_id AND r.company_id = e.company_id
        WHERE e.user_id = $1 AND e.company_id = $2 AND e.is_archived = false
        LIMIT 1`,
      [String(user.user_id), String(companyId)],
    );
    return {
      can_view_profit: rows[0]?.can_view_profit === true,
      is_administrator: rows[0]?.is_administrator === true,
    };
  }
}
