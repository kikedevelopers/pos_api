import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { UserType } from '@/common/types/jwt-payload.type';

/**
 * Usuario serializado tal como lo expone el contrato PlacePos en el payload
 * de login/register.
 *
 * - `id`: numérico (PG bigint → JS number; ver `bigintToNumber`).
 * - `email`: SIEMPRE string. Si el storage tiene `null` (Employee sin email),
 *   el mapper lo proyecta a `''` para alinear con `LoginResponse.user.email:
 *   string` del cliente PlacePos.
 * - `lastname`: SIEMPRE string. Employee sin lastname → `''`.
 * - `type`: string del enum `UserType`. Se expone como `string` plano para
 *   alinear con el cliente Electron, que no consume el enum tipado.
 */
export class AuthUserDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Kike' })
  name!: string;

  @ApiProperty({ example: 'Pacheco' })
  lastname!: string;

  @ApiProperty({ example: 'kike@ares.pos' })
  email!: string;

  @ApiProperty({ example: 'owner', enum: ['superadmin', 'owner', 'manager', 'employee'] })
  type!: UserType;
}

/**
 * Respuesta de `POST /auth/register` y `POST /auth/user`. Sale envuelta por
 * `ResponseWrapperInterceptor` en `{ success: true, payload: <esto> }`.
 */
export class AuthResponseDto {
  @ApiProperty({ description: 'JWT firmado. Adjuntar como `Authorization: Bearer <token>`.' })
  access_token!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

/**
 * Item de `company_profile` — paridad byte-a-byte con `CompanyProfile` del
 * cliente PlacePos (`api/requests/authentication/types.ts`).
 *
 * - `is_branch`: SIEMPRE `false` en CLOUD (esta fase no soporta sucursales).
 * - `balance`: `numeric(15,2)` en DB. El mapper lo convierte a `number`.
 * - `created_at` / `updated_at`: ISO 8601 string.
 */
export class CompanyProfileItemDto {
  @ApiProperty({ example: 42 })
  id!: number;

  @ApiProperty({ example: 'Bodegón Ares' })
  name!: string;

  @ApiProperty({ example: false })
  is_branch!: boolean;

  @ApiProperty({ example: 0 })
  balance!: number;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  document_number!: string | null;

  @ApiPropertyOptional({ example: 'Caracas, Venezuela', nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ example: 'contacto@ares.pos', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: '+58 412 1234567', nullable: true })
  phone_number!: string | null;

  @ApiProperty({ example: '2025-01-01T00:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2025-01-01T00:00:00.000Z' })
  updated_at!: string;
}

/**
 * Sub-objeto `user_profile` de `GET /auth/profile` — paridad PlacePos.
 */
export class UserProfileDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Kike' })
  name!: string;

  @ApiProperty({ example: 'Pacheco' })
  lastname!: string;

  @ApiProperty({ example: 'kike@ares.pos' })
  email!: string;

  @ApiProperty({ example: 'owner', enum: ['superadmin', 'owner', 'manager', 'employee'] })
  type!: UserType;

  @ApiProperty({ example: '2025-01-01T00:00:00.000Z' })
  created_at!: string;
}

/**
 * Sub-objeto `company_profile` de `GET /auth/profile` — paridad PlacePos.
 *
 * `primary` puede ser `null` para superadmin (sin tenant). El frontend
 * normal siempre ve una company.
 */
export class CompanyProfileGroupDto {
  @ApiPropertyOptional({ type: CompanyProfileItemDto, nullable: true })
  primary!: CompanyProfileItemDto | null;

  @ApiProperty({ type: [CompanyProfileItemDto] })
  companies!: CompanyProfileItemDto[];
}

/**
 * Respuesta de `GET /auth/profile` — paridad PlacePos
 * (`ProfilePayload` del cliente).
 */
export class ProfileResponseDto {
  @ApiProperty({ type: CompanyProfileGroupDto })
  company_profile!: CompanyProfileGroupDto;

  @ApiProperty({ type: UserProfileDto })
  user_profile!: UserProfileDto;
}

/**
 * Respuesta de `GET /auth/me` — paridad PlacePos local (`auth.routes.ts:193`).
 *
 * El cliente lee `data.payload.user` para obtener el snapshot, así que aquí
 * envolvemos en `{ user }`.
 */
export class MeResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}
