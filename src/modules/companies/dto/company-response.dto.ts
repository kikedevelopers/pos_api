import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Company } from '../entities/company.entity';

/**
 * Shape de respuesta del módulo `companies`. Espeja byte-a-byte el payload
 * de `companies.routes.ts` de PlacePos (`mapCompanyRow`), añadiendo los
 * timestamps que el cliente CLOUD necesita para sincronización.
 *
 *   - `id` se serializa como `number` (bigint cast).
 *   - `break_even_amount` como `number` (transformer ya hizo `Number(...)`).
 *   - `created_at` / `updated_at` como ISO 8601.
 *
 * NO se exponen `balance` ni la relación `users` (irrelevantes para el
 * cliente y potencialmente sensibles).
 */
export class CompanyResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Mi Negocio C.A.' })
  name!: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  document_number!: string | null;

  @ApiPropertyOptional({ example: 'Av. Principal, Edif. Plaza, Piso 1', nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ example: 'contacto@minegocio.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: '+58 412-1234567', nullable: true })
  phone_number!: string | null;

  @ApiProperty({ example: 1000 })
  break_even_amount!: number;

  @ApiProperty({ example: 30 })
  break_even_period_days!: number;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

export function toCompanyResponseDto(company: Company): CompanyResponseDto {
  return {
    id: Number(company.id),
    name: company.name,
    document_number: company.document_number,
    address: company.address,
    email: company.email,
    phone_number: company.phone_number,
    break_even_amount: Number(company.break_even_amount),
    break_even_period_days: company.break_even_period_days,
    created_at: company.created_at.toISOString(),
    updated_at: company.updated_at.toISOString(),
  };
}
