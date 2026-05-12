import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Payload de `PUT /employees/:id/toggle-login`.
 *
 * Habilita o deshabilita el acceso del employee a `POST /auth/user`. Si
 * `enabled = true` y el employee no tiene credenciales asignadas
 * (`username`/`password`), el service responde 422 — la transición es
 * inválida hasta que se asignen credenciales por `PUT /employees/:id/credentials`.
 */
export class ToggleLoginDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}
