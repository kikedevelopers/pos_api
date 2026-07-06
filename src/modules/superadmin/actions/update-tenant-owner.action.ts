import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UpdateMeAction } from '@/modules/users/actions/update-me.action';
import type { UpdateMeDto } from '@/modules/users/dto/update-me.dto';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { SuperadminTenantOwnerDto } from '../dto/superadmin-tenant-detail.dto';

/**
 * Edita el perfil (name/lastname/email) del owner de un tenant desde el panel
 * superadmin (firmado). REUTILIZA `UpdateMeAction` — la misma lógica de
 * `PUT /users/me` de placepos: update parcial, email normalizado a minúsculas
 * y traducción de la violación de UNIQUE a 409 `EMAIL_TAKEN`. Paridad total.
 *
 * Resuelve el owner por `company_id` + `type = owner` (un owner por tenant) y
 * delega en el action de auth/users con su id real.
 */
@Injectable()
export class UpdateTenantOwnerAction {
  private readonly logger = new Logger(UpdateTenantOwnerAction.name);

  constructor(
    private readonly updateMeAction: UpdateMeAction,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async execute(companyId: number, dto: UpdateMeDto): Promise<SuperadminTenantOwnerDto> {
    const owner = await this.userRepo.findOne({
      where: { company_id: String(companyId), type: UserType.OWNER },
    });
    if (!owner) {
      throw new NotFoundException(`La company ${companyId} no tiene owner.`);
    }

    const updated = await this.updateMeAction.execute(Number(owner.id), dto);

    this.logger.log({
      event: 'superadmin.owner.updated',
      companyId,
      ownerUserId: Number(updated.id),
    });

    return {
      id: Number(updated.id),
      name: updated.name,
      lastname: updated.lastname,
      email: updated.email,
      lastLogin: updated.last_login ? updated.last_login.toISOString() : null,
    };
  }
}
