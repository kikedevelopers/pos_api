import { Injectable } from '@nestjs/common';

import {
  type PermissionActor,
  ResolveEffectivePermissionsAction,
} from './actions/resolve-effective-permissions.action';
import { CreateRoleAction } from './actions/create-role.action';
import { DeleteRoleAction } from './actions/delete-role.action';
import { ListRolesAction } from './actions/list-roles.action';
import { UpdateRoleAction, type UpdateRoleResult } from './actions/update-role.action';
import type { CreateRoleDto } from './dto/create-role.dto';
import type { RoleListRow } from './dto/role-response.dto';
import type { UpdateRoleDto } from './dto/update-role.dto';
import type { Role } from './entities/role.entity';
import type { PermissionKey } from './internal/permission-catalog';

/**
 * Facade delgado del dominio `roles`. ZERO lógica de negocio — solo delega a
 * la action correspondiente. Patrón §3.1 del CLAUDE.md.
 *
 * Expone también `resolveEffectivePermissions` para que `AuthModule` (perfil)
 * lo consuma sin acoplarse a la action concreta.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly listRolesAction: ListRolesAction,
    private readonly createRoleAction: CreateRoleAction,
    private readonly updateRoleAction: UpdateRoleAction,
    private readonly deleteRoleAction: DeleteRoleAction,
    private readonly resolveEffectivePermissionsAction: ResolveEffectivePermissionsAction,
  ) {}

  list(companyId: number): Promise<RoleListRow[]> {
    return this.listRolesAction.execute(companyId);
  }

  create(dto: CreateRoleDto, companyId: number): Promise<Role> {
    return this.createRoleAction.execute(dto, companyId);
  }

  update(id: number, dto: UpdateRoleDto, companyId: number): Promise<UpdateRoleResult> {
    return this.updateRoleAction.execute(id, dto, companyId);
  }

  delete(id: number, companyId: number): Promise<void> {
    return this.deleteRoleAction.execute(id, companyId);
  }

  resolveEffectivePermissions(actor: PermissionActor): Promise<PermissionKey[]> {
    return this.resolveEffectivePermissionsAction.execute(actor);
  }
}
