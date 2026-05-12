import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { UserType } from '@/common/types/jwt-payload.type';

/**
 * Usuario serializado tal como lo expone el contrato PlacePos en el payload
 * de login/register y en `GET /auth/me`.
 *
 * - `id`: numérico (PG bigint → JS number; ver `AuthService.toAuthUserDto`).
 * - `email`: puede ser `null` para flujos futuros de Employee sin email.
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

  @ApiPropertyOptional({ example: 'kike@ares.pos', nullable: true })
  email!: string | null;

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
 * Datos públicos de Company expuestos en `GET /auth/profile`.
 *
 * Divergencia consciente vs PlacePos: NO se expone `balance` aquí. PlacePos
 * lo incluye porque en modo local el balance es info personal del operador;
 * en CLOUD el balance es info operacional sensible y se sirve por endpoints
 * específicos del dashboard. El owner igualmente lo verá vía `GET /companies`
 * en su fase.
 */
export class CompanyProfileDto {
  @ApiProperty({ example: 42 })
  id!: number;

  @ApiProperty({ example: 'Bodegón Ares' })
  name!: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  document_number!: string | null;

  @ApiPropertyOptional({ example: 'Caracas, Venezuela', nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ example: 'contacto@ares.pos', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: '+58 412 1234567', nullable: true })
  phone_number!: string | null;

  @ApiProperty({ example: 0 })
  break_even_amount!: number;

  @ApiProperty({ example: 30 })
  break_even_period_days!: number;
}

/**
 * Respuesta de `GET /auth/profile`.
 */
export class ProfileResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiProperty({ type: CompanyProfileDto, nullable: true })
  company!: CompanyProfileDto | null;
}
