import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SubscriptionResponseDto } from '@/modules/subscriptions/dto/subscription-response.dto';

/** Datos del dueño tal como los pinta el portal. Sin password ni flags internos. */
export class PortalUserDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Kike' })
  name!: string;

  @ApiProperty({ example: 'Pacheco' })
  lastname!: string;

  @ApiProperty({ example: 'kike@ares.pos' })
  email!: string;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  created_at!: string;
}

/** Negocio principal del dueño. */
export class PortalCompanyDto {
  @ApiProperty({ example: 42 })
  id!: number;

  @ApiProperty({ example: 'Bodegón Ares' })
  name!: string;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  document_number!: string | null;

  @ApiPropertyOptional({ example: '+57 311 7323107', nullable: true })
  phone_number!: string | null;

  @ApiProperty({ example: '2026-01-01T00:00:00.000Z' })
  created_at!: string;

  /**
   * Sucursales ADICIONALES del dueño (sin contar el principal). El portal lo
   * usa para decir "y 2 sucursales" — cada sede extra se cotiza aparte, así
   * que el dueño tiene que verlas donde ve lo que paga.
   */
  @ApiProperty({ example: 0 })
  branches_count!: number;
}

/** Respuesta de `GET /portal/account`. */
export class PortalAccountResponseDto {
  @ApiProperty({ type: PortalUserDto })
  user!: PortalUserDto;

  @ApiProperty({ type: PortalCompanyDto })
  company!: PortalCompanyDto;

  @ApiPropertyOptional({
    type: SubscriptionResponseDto,
    nullable: true,
    description:
      'La suscripción aplicable. `null` solo si la cuenta no tiene (dato inconsistente).',
  })
  subscription!: SubscriptionResponseDto | null;
}
