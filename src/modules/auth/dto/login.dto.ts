import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Payload de `POST /auth/user`.
 *
 * Nota de naming: el campo se llama `username` aunque en este API y en
 * PlacePos los Users autentican por email. Se mantiene el nombre por paridad
 * con el cliente Electron (espera el campo `username`, no `email`).
 * Cuando llegue Fase 2 (Employees), este campo será literalmente
 * `employees.username` para ese flujo.
 */
export class LoginDto {
  @ApiProperty({
    example: 'kike@ares.pos',
    description: 'Email del User o username del Employee.',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty({ message: 'username es requerido' })
  @MaxLength(255)
  username!: string;

  @ApiProperty({ example: 'contrasenaSegura1!', maxLength: 128 })
  @IsString()
  @IsNotEmpty({ message: 'password es requerido' })
  @MaxLength(128)
  password!: string;
}
