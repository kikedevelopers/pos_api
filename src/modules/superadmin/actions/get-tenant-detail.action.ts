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
    const [owner, subscription, ventas, compras, clientes, productos, proveedores, gastos] =
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
      },
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
