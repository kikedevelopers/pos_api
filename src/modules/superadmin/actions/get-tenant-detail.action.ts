import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Company } from '@/modules/companies/entities/company.entity';
import { Subscription } from '@/modules/subscriptions/entities/subscription.entity';
import { User, UserType } from '@/modules/users/entities/user.entity';

import type { SuperadminTenantDetailDto } from '../dto/superadmin-tenant-detail.dto';

/**
 * Detalle cross-tenant de una company para el panel superadmin: company, owner,
 * suscripción y conteos por dominio.
 *
 * Acceso controlado por firma asimétrica en el controller
 * (`SuperadminSignatureGuard`), no por rol/tenant. Read puro — sin transacción.
 *
 * Los COUNT se hacen scoped por `company_id` directamente sobre cada repo
 * (índice por company_id en cada tabla). Se lanzan en paralelo con
 * `Promise.all` para no encadenar 6 round-trips secuenciales.
 *
 * --------------------------------------------------------------------------
 * Sucursales
 * --------------------------------------------------------------------------
 *
 * Una sucursal (`companies.is_branch = true`) es un tenant completo en cuanto a
 * datos —sus productos, ventas y clientes están aislados por `company_id`— pero
 * NO tiene identidad propia:
 *
 *   - No hay fila en `users` con su `company_id`: el owner es el del negocio
 *     principal y se alcanza por `company_members`.
 *   - No tiene suscripción propia: la vigencia es la del negocio principal.
 *
 * Por eso, cuando la company pedida es una sucursal, el owner y la suscripción
 * se resuelven a través del principal, y se informa cuál es (`parent`) para que
 * el panel pueda enlazarlo. Sin esto, el detalle de una sucursal se veía como
 * una cuenta huérfana: sin propietario y sin suscripción.
 */
@Injectable()
export class GetTenantDetailAction {
  constructor(
    @InjectRepository(Company)
    private readonly companyRepo: Repository<Company>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepo: Repository<Subscription>,
  ) {}

  async execute(companyId: number): Promise<SuperadminTenantDetailDto> {
    const company = await this.companyRepo.findOne({ where: { id: String(companyId) } });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} no existe.`);
    }

    // owner + suscripción + conteos en paralelo (cada COUNT está indexado por
    // company_id). Evita 8 round-trips secuenciales.
    const [directOwner, directSubscription, ventas, compras, clientes, productos, proveedores, gastos] =
      await Promise.all([
        this.userRepo.findOne({
          where: { company_id: String(companyId), type: UserType.OWNER },
        }),
        this.subscriptionRepo.findOne({ where: { company_id: String(companyId) } }),
        this.countByCompany('sale_invoices', companyId),
        this.countByCompany('purchases', companyId),
        this.countByCompany('customers', companyId),
        this.countByCompany('products', companyId),
        this.countByCompany('suppliers', companyId),
        this.countByCompany('expenses', companyId),
      ]);

    // En una sucursal, owner y suscripción cuelgan del negocio principal.
    let owner = directOwner;
    let subscription = directSubscription;
    let parent: SuperadminTenantDetailDto['parent'] = null;

    if (company.is_branch) {
      const inherited = await this.resolveBranchParent(companyId);
      parent = inherited.parent;
      owner = owner ?? inherited.owner;
      subscription = subscription ?? inherited.subscription;
    }

    const now = Date.now();

    // Gating de sucursales del owner + conteos (creadas / activas) vía
    // company_members ⋈ companies (is_branch). Solo si hay owner.
    let branches: SuperadminTenantDetailDto['branches'] = null;
    if (owner) {
      const rows = await this.companyRepo.manager.query<
        Array<{ count: string; active_count: string }>
      >(
        `SELECT
           COUNT(*)::text AS count,
           COUNT(*) FILTER (WHERE cm.is_active)::text AS active_count
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
         WHERE cm.user_id = $1 AND c.is_branch = true`,
        [owner.id],
      );
      branches = {
        enabled: owner.branches_enabled,
        allowed: owner.branches_allowed,
        count: Number(rows[0]?.count ?? 0),
        activeCount: Number(rows[0]?.active_count ?? 0),
      };
    }

    return {
      company: {
        id: Number(company.id),
        name: company.name,
        documentNumber: company.document_number,
        address: company.address,
        email: company.email,
        phoneNumber: company.phone_number,
        origin: company.origin,
        createdAt: company.created_at.toISOString(),
        isBranch: company.is_branch,
      },
      parent,
      owner: owner
        ? {
            id: Number(owner.id),
            name: owner.name,
            lastname: owner.lastname,
            email: owner.email,
            lastLogin: owner.last_login ? owner.last_login.toISOString() : null,
          }
        : null,
      subscription: subscription
        ? {
            startedAt: subscription.started_at.toISOString(),
            expiresAt: subscription.expires_at.toISOString(),
            active: subscription.expires_at.getTime() > now,
          }
        : null,
      counts: { ventas, compras, clientes, productos, proveedores, gastos },
      branches,
    };
  }

  /**
   * Resuelve, para una sucursal, quién es su negocio principal y de quién
   * hereda owner y suscripción.
   *
   * El camino es `company_members` → `users` (el owner de la membresía) →
   * `users.company_id` (su negocio principal, el del login). Se toma la
   * membresía de rol `owner`; si por lo que sea hubiera varias, la más antigua
   * manda — es la del alta original.
   *
   * Devuelve todo en `null` si la sucursal quedó sin membresía (dato
   * inconsistente): el detalle se sigue mostrando, solo que sin herencia. Nunca
   * revienta por esto.
   */
  private async resolveBranchParent(companyId: number): Promise<{
    parent: SuperadminTenantDetailDto['parent'];
    owner: User | null;
    subscription: Subscription | null;
  }> {
    const rows = await this.companyRepo.manager.query<Array<{ user_id: string }>>(
      `SELECT cm.user_id::text AS user_id
       FROM company_members cm
       WHERE cm.company_id = $1 AND cm.role = 'owner'
       ORDER BY cm.id ASC
       LIMIT 1`,
      [companyId],
    );
    const ownerId = rows[0]?.user_id;
    if (!ownerId) {
      return { parent: null, owner: null, subscription: null };
    }

    const owner = await this.userRepo.findOne({ where: { id: ownerId } });
    // `users.company_id` es nullable en el modelo: sin él no hay principal del
    // que heredar, pero el owner sí es válido y se devuelve igual.
    if (!owner?.company_id) {
      return { parent: null, owner: owner ?? null, subscription: null };
    }
    const parentId = owner.company_id;

    const [parentCompany, subscription] = await Promise.all([
      this.companyRepo.findOne({ where: { id: parentId } }),
      this.subscriptionRepo.findOne({ where: { company_id: parentId } }),
    ]);

    return {
      parent: parentCompany
        ? { id: Number(parentCompany.id), name: parentCompany.name }
        : null,
      owner,
      subscription,
    };
  }

  /**
   * COUNT(*) scoped por company_id sobre una tabla arbitraria. `table` es un
   * literal controlado por este action (nunca input del cliente), así que es
   * seguro interpolarlo; `companyId` va parametrizado.
   */
  private async countByCompany(table: string, companyId: number): Promise<number> {
    const row = await this.companyRepo.manager.query<Array<{ count: string }>>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE company_id = $1`,
      [companyId],
    );
    return Number(row[0]?.count ?? 0);
  }
}
