import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  CompanyResponseDto,
  toCompanyResponseDto,
} from '@/modules/companies/dto/company-response.dto';

import { User } from '../entities/user.entity';

/**
 * Owner + su company principal, para el panel admin (`GET /admin/users/owners`).
 * Nunca expone el `password`. `company` es la company del owner (NOT NULL por
 * CHECK), pero se tipa nullable por seguridad.
 */
export class AdminOwnerResponseDto {
  @ApiProperty({ example: 9 })
  id!: number;

  @ApiProperty({ example: 'Kike' })
  name!: string;

  @ApiProperty({ example: 'Dev' })
  lastname!: string;

  @ApiProperty({ example: 'owner@empresa.com' })
  email!: string;

  @ApiProperty({ example: 'owner' })
  type!: string;

  @ApiProperty({ example: 0 })
  balance!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;

  @ApiPropertyOptional({ type: CompanyResponseDto, nullable: true })
  company!: CompanyResponseDto | null;
}

export function toAdminOwnerResponseDto(user: User): AdminOwnerResponseDto {
  return {
    id: Number(user.id),
    name: user.name,
    lastname: user.lastname,
    email: user.email,
    type: user.type,
    balance: Number(user.balance),
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
    company: user.company ? toCompanyResponseDto(user.company) : null,
  };
}
