import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CompanyMember } from '@/modules/companies/entities/company-member.entity';
import { Company } from '@/modules/companies/entities/company.entity';
import { seedSystemRolesForCompany } from '@/modules/roles/internal/system-roles';
import { User } from '@/modules/users/entities/user.entity';

import type { CreateBranchDto } from '../dto/create-branch.dto';
import { SeedCompanyAction } from './seed-company.action';

/** Actor (owner) que crea la sucursal, propagado desde el JWT. */
export interface BranchCreator {
  userId: number;
  fullName: string;
}

/**
 * Crea una sucursal del owner autenticado: una `Company` nueva con
 * `is_branch=true`, su fila de membresía (`company_members`) y los seeds +
 * suscripción trial. Todo en una transacción — si falla un paso, rollback.
 *
 * El owner NO se re-crea: la sucursal se asocia al `User` existente vía
 * `company_members`. El aislamiento de datos lo da `company_id`; esta company
 * arranca vacía (solo los seeds esenciales).
 */
@Injectable()
export class CreateBranchAction {
  private readonly logger = new Logger(CreateBranchAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly seedCompanyAction: SeedCompanyAction,
  ) {}

  async execute(dto: CreateBranchDto, creator: BranchCreator): Promise<Company> {
    // SERIALIZABLE: el gating (enabled + límite) debe ser atómico para evitar
    // que dos POST concurrentes creen ambos la sucursal N+1.
    const saved = await this.dataSource.transaction<Company>('SERIALIZABLE', async (manager) => {
      // 0. Gating — [SEGURIDAD] validar en backend, no confiar en la UI.
      const owner = await manager.getRepository(User).findOne({
        where: { id: String(creator.userId) },
      });
      if (!owner) {
        throw new NotFoundException('Usuario no encontrado');
      }
      if (!owner.branches_enabled) {
        throw new ForbiddenException('Las sucursales no están habilitadas para esta cuenta.');
      }
      const countRows = await manager.query<Array<{ count: string }>>(
        `SELECT COUNT(*)::text AS count
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
         WHERE cm.user_id = $1 AND c.is_branch = true`,
        [creator.userId],
      );
      const currentBranches = Number(countRows[0]?.count ?? 0);
      if (currentBranches >= owner.branches_allowed) {
        throw new ForbiddenException(
          `Límite de sucursales alcanzado (${owner.branches_allowed}).`,
        );
      }

      // 1. Company nueva marcada como sucursal. TypeORM 0.3 no aplica defaults
      //    SQL si la columna no aparece en create(): seteamos los NOT NULL.
      const company = manager.create(Company, {
        name: dto.company_name,
        document_number: dto.document_number?.trim() || null,
        address: dto.address?.trim() || null,
        email: dto.email?.trim() || null,
        phone_number: dto.phone_number?.trim() || null,
        balance: 0,
        break_even_amount: 0,
        break_even_period_days: 30,
        origin: 'web',
        is_branch: true,
      });
      const savedCompany = await manager.save(Company, company);

      // 2. Membresía: el owner queda asociado a la sucursal.
      await manager.save(
        CompanyMember,
        manager.create(CompanyMember, {
          user_id: String(creator.userId),
          company_id: savedCompany.id,
          role: 'owner',
        }),
      );

      // 3. Seeds esenciales (misma transacción). La sucursal NO crea
      //    suscripción: comparte la del negocio principal del owner.
      await this.seedCompanyAction.execute(manager, {
        companyId: Number(savedCompany.id),
        createdBy: { id: creator.userId, fullName: creator.fullName },
      });

      // 3b. Roles de fábrica (Administrador, Cajero, Inventarista) — igual que
      //     el register: cada sucursal nace con sus 3 roles de sistema. Mismo
      //     manager → rollback total si algo falla (FASE 2, roles y permisos).
      await seedSystemRolesForCompany(manager, Number(savedCompany.id));

      return savedCompany;
    });

    this.logger.log({
      event: 'branch.created',
      ownerUserId: creator.userId,
      companyId: Number(saved.id),
    });

    return saved;
  }
}
