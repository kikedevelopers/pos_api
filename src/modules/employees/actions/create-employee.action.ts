import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';
import {
  DEFAULT_SYSTEM_ACCESS_ROLE_NAME,
  findRoleIdByName,
} from '@/modules/roles/internal/system-roles';

import type { CreateEmployeeDto } from '../dto/create-employee.dto';
import { Employee, EmployeeRole } from '../entities/employee.entity';
import { translateEmployeeConstraintError } from '../internal/constraint-errors';
import { ensureMirrorUserForEmployee } from '../internal/ensure-mirror-user-for-employee.helper';
import { resolveRoleIdOnCreate } from '../internal/role-assignment';
import { resolveCashVisibilityOnRoleChange } from '../internal/cash-visibility';
import { assertRoleBelongsToCompany } from '../internal/role-validation';

/**
 * Datos del owner creador que el controller propaga al action. Evita pasar el
 * `AuthUser` completo (que tiene más campos) y mantiene la firma desacoplada
 * de la forma del JWT.
 */
export interface EmployeeCreator {
  id: number;
  fullName: string;
}

/**
 * Crea un employee. Reglas:
 *
 *   - Si `login_enabled = true` y falta `username` o `password`, lanza 400
 *     pre-flight (el DTO también lo valida con `@ValidateIf`, pero esta es una
 *     red de seguridad por si el caller futuro invoca el action fuera del
 *     flujo HTTP).
 *
 *   - Si `login_enabled = false`, ignora `username`/`password` recibidos.
 *
 *   - `username` colisionado → 409 con `code: USERNAME_TAKEN`. Detección por
 *     catch de `QueryFailedError` con el nombre del índice.
 *
 *   - `company_id`, `created_by`, `created_by_id` se asignan desde los
 *     parámetros `companyId` y `createdBy` — NUNCA del DTO.
 *
 * Transacción: el INSERT vive dentro de `dataSource.transaction` aunque sea
 * "un solo paso". Razón: §8.8 del CLAUDE.md — defensa en profundidad para que
 * futuros side-effects (FK cascade, triggers, audit en DB) hereden atomicidad
 * sin que nadie revise.
 */
@Injectable()
export class CreateEmployeeAction {
  private readonly logger = new Logger(CreateEmployeeAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreateEmployeeDto,
    companyId: number,
    createdBy: EmployeeCreator,
  ): Promise<Employee> {
    // Pre-flight: red de seguridad. El DTO ya lo cubre con @ValidateIf, pero
    // si alguien invoca el action directamente (test, queue worker), esto
    // protege la invariante del CHECK constraint.
    if (dto.login_enabled === true && (!dto.username || !dto.password)) {
      throw new BadRequestException('Username y password son requeridos para habilitar login');
    }

    // Hashing FUERA de la transacción: argon2 toma ~50-100ms y mantener una
    // conexión abierta esperándolo bloquea el pool sin beneficio (el hash no
    // depende del estado de DB).
    const hashedPassword =
      dto.login_enabled === true && dto.password
        ? await argon2.hash(dto.password, ARGON2_OPTIONS)
        : null;

    const saved = await this.dataSource.transaction<Employee>(async (manager) => {
      // FASE 2 (ROLES): blindaje multi-tenant. Si viene un role_id, debe
      // pertenecer a la company del actor — se valida SIEMPRE (un role_id ajeno
      // o inexistente → 400), aunque luego no se persista por no tener acceso.
      if (dto.role_id !== undefined && dto.role_id !== null) {
        await assertRoleBelongsToCompany(manager, dto.role_id, companyId);
      }

      // Default 'Vendedor': el rol SOLO se persiste con acceso al sistema. Solo
      // resolvemos el rol por defecto cuando hará falta (login sin rol explícito)
      // para no gastar una query de más. La decisión vive en `resolveRoleIdOnCreate`.
      const defaultRoleId =
        dto.login_enabled === true && dto.role_id == null
          ? await findRoleIdByName(manager, companyId, DEFAULT_SYSTEM_ACCESS_ROLE_NAME)
          : null;
      const resolvedRoleId = resolveRoleIdOnCreate(
        dto.login_enabled === true,
        dto.role_id != null ? String(dto.role_id) : null,
        defaultRoleId,
      );

      // Ver caja nace en false, salvo que se cree con rol "Cajero": ahí se activa
      // por defecto (previousRoleId=null → transición). Paridad PlacePos.
      const cajeroRoleId = await findRoleIdByName(manager, companyId, 'Cajero');
      const cashDefault =
        resolveCashVisibilityOnRoleChange(resolvedRoleId, null, cajeroRoleId) ?? false;

      const employee = manager.create(Employee, {
        company_id: String(companyId),
        name: dto.name,
        phone: dto.phone ?? null,
        email: dto.email ?? null,
        address: dto.address ?? null,
        // Rol RBAC: 'Vendedor' por defecto al conceder acceso; null sin acceso.
        role_id: resolvedRoleId,
        // Default `employee` cuando el cliente no envía role (paridad PlacePos
        // — su formulario no expone el campo). El owner puede promoverlo
        // a `manager` después vía PUT.
        role: dto.role ?? EmployeeRole.EMPLOYEE,
        login_enabled: dto.login_enabled,
        // Si login_enabled = false, NO persistimos credenciales aunque vengan
        // en el DTO. Coherente con la regla de PlacePos y con el CHECK.
        username: dto.login_enabled === true ? (dto.username ?? null) : null,
        password: hashedPassword,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
        is_archived: false,
        // El acceso a márgenes/ganancias nace deshabilitado; solo un admin lo
        // concede después vía PUT /employees/:id/profit-visibility.
        can_view_profit: false,
        can_view_cash: cashDefault,
        user_id: null,
      });

      let persisted: Employee;
      try {
        persisted = await manager.save(Employee, employee);
      } catch (error) {
        translateEmployeeConstraintError(error, this.logger);
        throw error;
      }

      // Si el employee se crea con login habilitado, materializamos el User
      // espejo en la MISMA transacción. Razón: si la creación del espejo
      // falla (p.ej. EMAIL_TAKEN), debemos abortar el INSERT del employee
      // para no dejarlo a medias. El helper también setea `user_id` en el
      // employee recién creado.
      if (persisted.login_enabled === true) {
        await ensureMirrorUserForEmployee({
          manager,
          employee: persisted,
          companyId,
        });
      }

      return persisted;
    });

    // Audit log post-commit. NO incluye username/password/hash — solo IDs y
    // acción. Si la transacción falla, este log NO se emite (correcto).
    if (saved.login_enabled === true) {
      this.logger.log({
        event: 'employee.credentials_updated',
        actorId: createdBy.id,
        targetEmployeeId: Number(saved.id),
        companyId,
        action: 'createWithLogin',
      });
    }

    return saved;
  }
}
