import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { maskEmail } from '@/modules/mail/internal/mail-address';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { UpdateActivationDto } from '../dto/update-activation.dto';

export interface UpdateActivationResult {
  /** Estado resultante: true = activada. */
  activated: boolean;
  /** Cuándo quedó activada. null si se dejó (o volvió a) sin activar. */
  activatedAt: string | null;
}

/**
 * Activa o desactiva MANUALMENTE la cuenta de un owner desde el panel superadmin
 * (firmado). Setea (o limpia) `users.activated_at` del owner de la company.
 *
 * A diferencia del canje del enlace del correo (`ActivateAccountAction`), aquí
 * NO se envía ningún correo: es una acción del operador, no del dueño.
 *
 * Reglas:
 *   - Actúa sobre el OWNER de la company (`type=owner`), igual que el reenvío de
 *     activación. Una sucursal no tiene owner propio: se administra desde el
 *     negocio principal (404 si se pide sobre una company sin owner).
 *   - `active=true` sobre una cuenta YA activa conserva su `activated_at`
 *     original: no se reescribe la fecha real de activación por un doble clic.
 *   - `active=false` la revierte a `null`, lo que vuelve a bloquear el login. No
 *     se tocan los tokens: si había uno consumido, la cuenta queda en `no_link`
 *     y el operador podrá reenviar el correo cuando quiera.
 *
 * Transacción SERIALIZABLE: escritura de control de acceso; evita pisar cambios
 * concurrentes sobre la fila del usuario.
 */
@Injectable()
export class UpdateActivationAction {
  private readonly logger = new Logger(UpdateActivationAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, dto: UpdateActivationDto): Promise<UpdateActivationResult> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const owner = await manager.findOne(User, {
        where: { company_id: String(companyId), type: UserType.OWNER },
      });
      if (!owner) {
        throw new NotFoundException('No se encontró el dueño de esta cuenta.');
      }

      // Conservar la fecha real al reactivar; limpiar al desactivar.
      const activatedAt = dto.active ? (owner.activated_at ?? new Date()) : null;

      // No escribir si ya está en el estado pedido: evita un UPDATE inútil y no
      // reescribe `activated_at` de una cuenta ya activa.
      const changed = (owner.activated_at?.getTime() ?? null) !== (activatedAt?.getTime() ?? null);
      if (changed) {
        await manager.update(User, owner.id, { activated_at: activatedAt });
        this.logger.log({
          event: 'superadmin.activation.updated',
          companyId,
          active: dto.active,
          ownerEmail: maskEmail(owner.email),
        });
      }

      return {
        activated: activatedAt !== null,
        activatedAt: activatedAt ? activatedAt.toISOString() : null,
      };
    });
  }
}
