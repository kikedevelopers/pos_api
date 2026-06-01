import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import type { ListOwnersQueryDto } from '@/modules/users/dto/list-owners-query.dto';
import { User, UserType } from '@/modules/users/entities/user.entity';

/**
 * Fila plana del listado superadmin: owner + company + (opcional) suscripción.
 * Se devuelve ya proyectada (no la entidad) porque el dato de suscripción no
 * cuelga de la relación de `User`; viene de un LEFT JOIN manual.
 */
export interface ListTenantsItem {
  companyId: number;
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  documentNumber: string | null;
  createdAt: string;
  subscriptionStartedAt: string | null;
  subscriptionExpiresAt: string | null;
}

export interface ListTenantsResult {
  tenants: ListTenantsItem[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Lista TODOS los owners (cross-tenant) con su company y su suscripción para el
 * panel kdevs-admin ("Cuentas"). Variante de `ListOwnersAction` que ADEMÁS trae
 * la vigencia de la suscripción en la MISMA fila, para que el panel calcule días
 * restantes sin pedir el detalle por tenant.
 *
 * Acceso controlado por firma asimétrica en el controller
 * (`SuperadminSignatureGuard`), no por rol/tenant. Read puro — sin transacción.
 *
 * Diseño del query:
 *   - `users u` (type='owner')  INNER JOIN  `companies c`  (owner siempre tiene
 *     company; el INNER no descarta filas válidas y permite filtrar por c.name).
 *   - LEFT JOIN `subscriptions s` ON s.company_id = u.company_id  — la company
 *     PODRÍA no tener suscripción, así que LEFT (no descartar la fila).
 *   - El JOIN a subscriptions usa `subscriptions.company_id` que está indexado
 *     UNIQUE (`idx_subscriptions_company_id_unique`), por lo que es un lookup
 *     puntual por fila, no un scan.
 *
 * Se usa `getRawAndEntities` para hidratar `u`+`c` como entidades y leer los
 * campos de la suscripción del raw (`s_started_at`, `s_expires_at`); un único
 * query para la página. El total va en un COUNT aparte sobre el mismo filtro.
 */
@Injectable()
export class ListTenantsAction {
  constructor(
    @InjectRepository(User)
    private readonly repo: Repository<User>,
  ) {}

  async execute(query: ListOwnersQueryDto): Promise<ListTenantsResult> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const base = this.repo
      .createQueryBuilder('u')
      .innerJoinAndSelect('u.company', 'c')
      .leftJoin(
        Subscription,
        's',
        's.company_id = u.company_id',
      )
      .where('u.type = :type', { type: UserType.OWNER });

    if (query.search) {
      base.andWhere(
        '(u.name ILIKE :s OR u.lastname ILIKE :s OR u.email ILIKE :s OR c.name ILIKE :s)',
        { s: `%${query.search}%` },
      );
    }

    // total: COUNT sobre el mismo filtro (clona el QB antes de paginar/seleccionar).
    const total = await base.clone().getCount();

    const { entities, raw } = await base
      .addSelect('s.started_at', 's_started_at')
      .addSelect('s.expires_at', 's_expires_at')
      .orderBy('u.created_at', 'DESC')
      .addOrderBy('u.id', 'DESC')
      .take(limit)
      .skip(offset)
      .getRawAndEntities();

    const tenants: ListTenantsItem[] = entities.map((owner, i) => {
      const row = raw[i] as { s_started_at: Date | null; s_expires_at: Date | null };
      return {
        companyId: owner.company ? Number(owner.company.id) : Number(owner.company_id),
        companyName: owner.company?.name ?? '',
        ownerName: `${owner.name} ${owner.lastname}`.trim(),
        ownerEmail: owner.email,
        documentNumber: owner.company?.document_number ?? null,
        createdAt: owner.created_at.toISOString(),
        subscriptionStartedAt: row?.s_started_at ? new Date(row.s_started_at).toISOString() : null,
        subscriptionExpiresAt: row?.s_expires_at ? new Date(row.s_expires_at).toISOString() : null,
      };
    });

    return { tenants, total, limit, offset };
  }
}
