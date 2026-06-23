import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { ResetOwnerPasswordDto } from '../dto/reset-owner-password.dto';

/**
 * Resetea la contraseña del owner de un tenant desde el panel superadmin
 * (firmado). A diferencia de `PUT /users/me/password` (placepos), NO verifica
 * la contraseña actual: es una operación de OPERADOR, no del propio owner.
 * Solo hashea la nueva con los MISMOS `ARGON2_OPTIONS` que el registro y el
 * cambio normal, así el owner puede iniciar sesión con ella en placepos.
 */
@Injectable()
export class ResetTenantOwnerPasswordAction {
  private readonly logger = new Logger(ResetTenantOwnerPasswordAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, dto: ResetOwnerPasswordDto): Promise<{ success: boolean }> {
    // Hashing fuera de la transacción (argon2 ~50-100ms) para no bloquear el
    // pool, igual que `RegisterAction`.
    const passwordHash = await argon2.hash(dto.password, ARGON2_OPTIONS);

    await this.dataSource.transaction(async (manager) => {
      const owner = await manager.findOne(User, {
        where: { company_id: String(companyId), type: UserType.OWNER },
      });
      if (!owner) {
        throw new NotFoundException(`La company ${companyId} no tiene owner.`);
      }
      await manager.update(User, { id: owner.id }, { password: passwordHash });
    });

    this.logger.warn({ event: 'superadmin.owner.password_reset', companyId });
    return { success: true };
  }
}
