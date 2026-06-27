import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { Company } from '@/modules/companies/entities/company.entity';
import { Employee } from '@/modules/employees/entities/employee.entity';
import { PERMISSION_KEYS, type PermissionKey } from '@/modules/roles/internal/permission-catalog';
import { RolesService } from '@/modules/roles/roles.service';
import { UsersService } from '@/modules/users/users.service';

import type { ProfileResponseDto, UserProfileDto } from '../dto/auth-response.dto';
import {
  companyToCompanyProfileItemDto,
  employeeToUserProfileDto,
  userToUserProfileDto,
} from '../internal/auth-mappers';
import { ListBranchesAction } from './list-branches.action';

/**
 * `GET /auth/profile`. Devuelve `{ company_profile, user_profile }` con el
 * shape exacto que el cliente PlacePos consume (`ProfilePayload` en
 * `api/requests/authentication/types.ts`).
 *
 * Paridad PlacePos:
 *   - `company_profile.primary` es la company del tenant (siempre única en
 *     CLOUD esta fase; sin sucursales).
 *   - `company_profile.companies` siempre `[primary]` cuando hay company.
 *   - Para superadmin: `primary: null`, `companies: []`.
 *   - El `user_profile` proviene de `users` (path owner/manager) o de
 *     `employees` (path employee con login_enabled).
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class GetProfileAction {
  private readonly logger = new Logger(GetProfileAction.name);

  constructor(
    private readonly usersService: UsersService,
    @InjectRepository(Company)
    private readonly companiesRepo: Repository<Company>,
    @InjectRepository(Employee)
    private readonly employeesRepo: Repository<Employee>,
    private readonly listBranchesAction: ListBranchesAction,
    private readonly rolesService: RolesService,
  ) {}

  async execute(authUser: AuthUser): Promise<ProfileResponseDto> {
    if (authUser.type === 'superadmin' || authUser.company_id === null) {
      // Superadmin no tiene tenant: devolvemos `primary: null`,
      // `companies: []` y un user_profile sintético basado en el JWT. No
      // tocamos `users` (no garantizamos que exista una fila para el JWT
      // del superadmin en este path; mantenemos consistencia con el
      // comportamiento de `GetMeAction` para superadmin).
      return {
        company_profile: { primary: null, companies: [] },
        user_profile: {
          id: authUser.user_id,
          name: authUser.name,
          lastname: authUser.lastname ?? '',
          email: '',
          type: authUser.type,
          created_at: new Date(0).toISOString(),
          branches_enabled: false,
          branches_allowed: 0,
          // superadmin → acceso total (las 18 keys del catálogo).
          permissions: [...PERMISSION_KEYS],
        },
      };
    }

    // Permisos efectivos del usuario (owner→todas; empleado→rol o legacy).
    const permissions = await this.rolesService.resolveEffectivePermissions(authUser);
    const userProfile = await this.resolveUserProfile(authUser, permissions);

    const company = await this.companiesRepo.findOne({
      where: { id: String(authUser.company_id) },
    });
    if (!company) {
      // Inconsistencia de datos: el JWT apunta a una company eliminada.
      throw new NotFoundException('Empresa no encontrada');
    }

    // Empleados: sin membresías ni selector — una sola company (la del JWT).
    if (authUser.account === 'employee') {
      const companyItem = companyToCompanyProfileItemDto(company, this.logger);
      return {
        company_profile: { primary: companyItem, companies: [companyItem] },
        user_profile: userProfile,
      };
    }

    // Owner: `companies` lista TODAS sus companies (principal + sucursales) con
    // su `is_active`. `primary` = la company activa del JWT (su `is_active`
    // sale de la lista; si el JWT apunta a una sucursal suspendida llega
    // `false` y el cliente fuerza el switch al principal).
    const companies = await this.listBranchesAction.execute(authUser.user_id);
    const primary =
      companies.find((c) => c.id === Number(authUser.company_id)) ??
      companyToCompanyProfileItemDto(company, this.logger);

    return {
      company_profile: { primary, companies },
      user_profile: userProfile,
    };
  }

  /**
   * Resuelve el `user_profile` según el `account` del JWT:
   *   - `account === 'employee'`: lee `employees` por `user_id` (FK al User
   *     espejo) + `company_id` + `is_archived: false`. Paridad con
   *     `placepos/auth.routes.ts:217`.
   *   - resto (`'user'`): lee `users` por id en company.
   */
  private async resolveUserProfile(
    authUser: AuthUser,
    permissions: PermissionKey[],
  ): Promise<UserProfileDto> {
    const companyId = authUser.company_id as number;

    if (authUser.account === 'employee') {
      const employee = await this.employeesRepo.findOne({
        where: {
          user_id: String(authUser.user_id),
          company_id: String(companyId),
          is_archived: false,
        },
      });
      if (!employee || !employee.login_enabled) {
        throw new NotFoundException('Empleado no encontrado');
      }
      return employeeToUserProfileDto(employee, this.logger, permissions);
    }

    // El owner (account 'user'): por user_id, no por company del JWT — su
    // cuenta es única y el JWT puede apuntar a una sucursal no-primaria.
    const user = await this.usersService.findById(authUser.user_id);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return userToUserProfileDto(user, this.logger, permissions);
  }
}
