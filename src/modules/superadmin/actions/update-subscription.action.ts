import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import { addDays } from '@/modules/subscriptions/subscriptions.constants';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { UpdateSubscriptionDto } from '../dto/update-subscription.dto';

/**
 * Fija o extiende la suscripción de una company desde el panel superadmin.
 *
 *   - `expiresAt`  → fija el vencimiento a esa fecha exacta.
 *   - `extendDays` → suma N días a `max(now, expiresAt actual)`. Si no hay
 *      suscripción previa, la base es `now` y `started_at = now`.
 *
 * Se ejecuta en transacción (`SERIALIZABLE`) porque es una escritura financiera
 * sensible (vigencia = acceso de pago) que puede crear o actualizar la fila
 * UNIQUE por company: serializable evita que dos PATCH concurrentes inserten
 * dos suscripciones o pisen el cálculo de extensión del otro.
 */
@Injectable()
export class UpdateSubscriptionAction {
  private readonly logger = new Logger(UpdateSubscriptionAction.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(companyId: number, dto: UpdateSubscriptionDto): Promise<Subscription> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const companyRepo = manager.getRepository(Company);
      const subRepo = manager.getRepository(Subscription);
      const userRepo = manager.getRepository(User);

      const company = await companyRepo.findOne({ where: { id: String(companyId) } });
      if (!company) {
        throw new NotFoundException(`Company ${companyId} no existe.`);
      }

      const now = new Date();
      const existing = await subRepo.findOne({ where: { company_id: String(companyId) } });

      const nextExpiresAt = this.computeExpiresAt(dto, now, existing?.expires_at ?? null);

      let saved: Subscription;
      if (existing) {
        existing.expires_at = nextExpiresAt;
        saved = await subRepo.save(existing);
      } else {
        // Sin suscripción previa: necesitamos el owner para `owner_user_id`
        // (NOT NULL). started_at = now.
        const owner = await userRepo.findOne({
          where: { company_id: String(companyId), type: UserType.OWNER },
        });
        if (!owner) {
          throw new NotFoundException(
            `La company ${companyId} no tiene owner; no se puede crear suscripción.`,
          );
        }
        const created = subRepo.create({
          company_id: String(companyId),
          owner_user_id: owner.id,
          started_at: now,
          expires_at: nextExpiresAt,
        });
        saved = await subRepo.save(created);
      }

      this.logger.log({
        event: 'superadmin.subscription.updated',
        companyId,
        mode: dto.expiresAt !== undefined ? 'set' : 'extend',
        expiresAt: saved.expires_at.toISOString(),
      });

      return saved;
    });
  }

  /**
   * Calcula el nuevo `expires_at`:
   *   - `expiresAt` definido → esa fecha exacta.
   *   - `extendDays` definido → max(now, expiresAt actual) + N días.
   *
   * El DTO garantiza (vía `@ValidateIf`) que exactamente uno está presente.
   */
  private computeExpiresAt(
    dto: UpdateSubscriptionDto,
    now: Date,
    currentExpiresAt: Date | null,
  ): Date {
    if (dto.expiresAt !== undefined) {
      return new Date(dto.expiresAt);
    }
    // extendDays está garantizado presente aquí.
    const base =
      currentExpiresAt !== null && currentExpiresAt.getTime() > now.getTime()
        ? currentExpiresAt
        : now;
    return addDays(base, dto.extendDays as number);
  }
}
