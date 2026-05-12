import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import type { AuthUser } from '@/common/types/jwt-payload.type';
import { Company } from '@/modules/companies/entities/company.entity';
import { UsersService } from '@/modules/users/users.service';

import type { ProfileResponseDto } from '../dto/auth-response.dto';
import { companyToCompanyProfileDto, userToAuthUserDto } from '../internal/auth-mappers';

import { GetMeAction } from './get-me.action';

/**
 * `GET /auth/profile`. Devuelve user + company.
 *
 * Read puro — no requiere transacción.
 */
@Injectable()
export class GetProfileAction {
  private readonly logger = new Logger(GetProfileAction.name);

  constructor(
    private readonly usersService: UsersService,
    @InjectRepository(Company)
    private readonly companiesRepo: Repository<Company>,
    private readonly getMeAction: GetMeAction,
  ) {}

  async execute(authUser: AuthUser): Promise<ProfileResponseDto> {
    if (authUser.type === 'superadmin' || authUser.company_id === null) {
      // Superadmin no tiene company asociada; devolvemos null como `company`.
      return {
        user: await this.getMeAction.execute(authUser),
        company: null,
      };
    }

    const user = await this.usersService.findByIdInCompany(authUser.user_id, authUser.company_id);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const company = await this.companiesRepo.findOne({
      where: { id: String(authUser.company_id) },
    });
    if (!company) {
      // Inconsistencia de datos: el JWT apunta a una company eliminada.
      throw new NotFoundException('Empresa no encontrada');
    }

    return {
      user: userToAuthUserDto(user, this.logger),
      company: companyToCompanyProfileDto(company, this.logger),
    };
  }
}
