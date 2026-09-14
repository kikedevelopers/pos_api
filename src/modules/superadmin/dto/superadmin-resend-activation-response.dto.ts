import { ApiProperty } from '@nestjs/swagger';

/** Respuesta de `POST /superadmin/tenants/:companyId/resend-activation`. */
export class SuperadminResendActivationResponseDto {
  @ApiProperty({ example: true, description: 'El proveedor aceptó el envío.' })
  sent!: boolean;

  @ApiProperty({
    example: 'kike@esenciaygrano.com',
    description: 'Dirección a la que salió el correo. Sin enmascarar: el operador debe leerla.',
  })
  email!: string;

  @ApiProperty({
    example: '2026-08-19T14:00:00.000Z',
    description: 'Vencimiento del enlace nuevo.',
  })
  expiresAt!: string;
}
