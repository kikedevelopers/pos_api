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
 *
 * Una fila puede ser el NEGOCIO PRINCIPAL del owner o una de sus SUCURSALES
 * (`isBranch`). Ambas son companies de pleno derecho —datos aislados por
 * `company_id`— y por eso comparten shape: el panel las abre con el mismo
 * detalle. Lo que distingue a la sucursal es que no tiene owner propio ni
 * suscripción propia: las hereda del principal (ver `parentCompanyId`).
 */
export interface ListTenantsItem {
  companyId: number;
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  documentNumber: string | null;
  createdAt: string;
  // Fecha/hora ISO del último login del owner. null si nunca ha iniciado sesión.
  lastLogin: string | null;
  subscriptionStartedAt: string | null;
  subscriptionExpiresAt: string | null;
  /** `true` si la fila es una sucursal (`companies.is_branch`). */
  isBranch: boolean;
  /** Negocio principal del que cuelga la sucursal. `null` en el principal. */
  parentCompanyId: number | null;
  parentCompanyName: string | null;
  /**
   * Sucursal seleccionable vs suspendida (`company_members.is_active`). Siempre
   * `true` para el negocio principal, que nunca se suspende.
   */
  active: boolean;
}

export interface ListTenantsResult {
  tenants: ListTenantsItem[];
  /**
   * Cuentas (negocios PRINCIPALES) que pasan el filtro — la unidad de
   * paginación. `tenants` puede traer más filas que `limit` porque las
   * sucursales viajan pegadas a su principal para no partir un grupo entre dos
   * páginas.
   */
  total: number;
  /** Sucursales incluidas en esta página (informativo para la UI). */
  branchCount: number;
  limit: number;
  offset: number;
}

/** Fila cruda de la consulta de sucursales por owner. */
interface BranchRow {
  user_id: string;
  id: string;
  name: string;
  document_number: string | null;
  created_at: Date;
  is_active: boolean;
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
 *
 * --------------------------------------------------------------------------
 * Sucursales
 * --------------------------------------------------------------------------
 *
 * Una sucursal es una `Company` con `is_branch = true` que cuelga del MISMO
 * owner vía `company_members`; no tiene fila propia en `users`, así que el
 * query de arriba (que parte de los owners) jamás la vería. Se traen aparte,
 * solo para los owners de la página, y se intercalan justo DEBAJO de su
 * negocio principal, ordenadas por antigüedad (la más vieja primero).
 *
 * La paginación cuenta CUENTAS (principales), no filas: si un owner tiene tres
 * sucursales, las cuatro filas viajan juntas. Partir un grupo entre dos páginas
 * dejaría sucursales huérfanas en pantalla, sin el negocio que las explica.
 *
 * La búsqueda es de GRUPO, no de fila: buscar el nombre de una sucursal trae
 * también a su principal (y al revés), porque quien busca "la sucursal del sur"
 * está buscando ese negocio, no una fila suelta.
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
      .leftJoin(Subscription, 's', 's.company_id = u.company_id')
      .where('u.type = :type', { type: UserType.OWNER });

    if (query.search) {
      // El EXISTS extiende el filtro a las SUCURSALES del owner: buscar el
      // nombre de una sucursal devuelve su grupo completo (principal incluido),
      // que es lo que espera quien busca. Sin él, escribir el nombre de la
      // sucursal no daría ningún resultado: no existe como fila de `users`.
      base.andWhere(
        `(u.name ILIKE :s OR u.lastname ILIKE :s OR u.email ILIKE :s OR c.name ILIKE :s
          OR EXISTS (
            SELECT 1
            FROM company_members cm
            JOIN companies bc ON bc.id = cm.company_id
            WHERE cm.user_id = u.id AND bc.is_branch = true AND bc.name ILIKE :s
          ))`,
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

    // Sucursales de los owners de ESTA página, agrupadas por owner.
    const branchesByOwner = await this.loadBranches(entities.map((o) => o.id));

    const tenants: ListTenantsItem[] = [];
    entities.forEach((owner, i) => {
      const row = raw[i] as { s_started_at: Date | null; s_expires_at: Date | null };
      const companyId = owner.company ? Number(owner.company.id) : Number(owner.company_id);
      const companyName = owner.company?.name ?? '';
      const ownerName = `${owner.name} ${owner.lastname}`.trim();

      tenants.push({
        companyId,
        companyName,
        ownerName,
        ownerEmail: owner.email,
        documentNumber: owner.company?.document_number ?? null,
        createdAt: owner.created_at.toISOString(),
        lastLogin: owner.last_login ? owner.last_login.toISOString() : null,
        subscriptionStartedAt: row?.s_started_at ? new Date(row.s_started_at).toISOString() : null,
        subscriptionExpiresAt: row?.s_expires_at ? new Date(row.s_expires_at).toISOString() : null,
        isBranch: false,
        parentCompanyId: null,
        parentCompanyName: null,
        active: true,
      });

      // Sucursales justo debajo de su principal, más antigua primero.
      for (const branch of branchesByOwner.get(String(owner.id)) ?? []) {
        tenants.push({
          companyId: Number(branch.id),
          companyName: branch.name,
          ownerName,
          ownerEmail: owner.email,
          documentNumber: branch.document_number,
          createdAt: new Date(branch.created_at).toISOString(),
          lastLogin: owner.last_login ? owner.last_login.toISOString() : null,
          // La sucursal NO tiene suscripción propia: está cubierta por la del
          // negocio principal. Se deja en null a propósito para que el panel la
          // muestre como heredada y no como "sin suscripción".
          subscriptionStartedAt: null,
          subscriptionExpiresAt: null,
          isBranch: true,
          parentCompanyId: companyId,
          parentCompanyName: companyName,
          active: branch.is_active,
        });
      }
    });

    const branchCount = tenants.filter((t) => t.isBranch).length;

    return { tenants, total, branchCount, limit, offset };
  }

  /**
   * Sucursales de los owners dados, indexadas por `user_id` y ordenadas por
   * antigüedad. Una sola consulta para toda la página (no N+1).
   *
   * Devuelve un mapa vacío si la página no trae owners: `= ANY('{}')` es válido
   * pero el round-trip sobra.
   */
  private async loadBranches(ownerIds: string[]): Promise<Map<string, BranchRow[]>> {
    const byOwner = new Map<string, BranchRow[]>();
    if (ownerIds.length === 0) {
      return byOwner;
    }

    const rows = await this.repo.manager.query<BranchRow[]>(
      `SELECT cm.user_id::text        AS user_id,
              c.id::text              AS id,
              c.name                  AS name,
              c.document_number       AS document_number,
              c.created_at            AS created_at,
              cm.is_active            AS is_active
       FROM company_members cm
       JOIN companies c ON c.id = cm.company_id
       WHERE cm.user_id = ANY($1::bigint[]) AND c.is_branch = true
       ORDER BY c.created_at ASC, c.id ASC`,
      [ownerIds],
    );

    for (const row of rows) {
      const list = byOwner.get(row.user_id);
      if (list) {
        list.push(row);
      } else {
        byOwner.set(row.user_id, [row]);
      }
    }
    return byOwner;
  }
}
