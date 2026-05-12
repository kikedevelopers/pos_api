import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload de `PUT /employees/:id/credentials`.
 *
 * Ambos campos son opcionales A NIVEL DE CLASS-VALIDATOR, pero el service
 * impone que al menos UNO esté presente — si ambos vienen vacíos, lanza un
 * `BadRequestException`. No usamos un validador de "uno de" en este DTO
 * porque la regla pertenece a la lógica del endpoint, no al shape del payload.
 *
 * Si el employee actualmente tiene `login_enabled = true` y la actualización
 * dejara `username` o `password` en NULL, el CHECK constraint de la DB lo
 * rechazaría — pero esto NO puede ocurrir aquí porque el DTO no permite
 * nullificar campos: solo cambiarlos. El nullificado va por `toggleLogin =
 * false` + un futuro endpoint de revocación.
 */
export class UpdateCredentialsDto {
  @ApiPropertyOptional({
    example: 'kike-bodegonares-2',
    minLength: 3,
    maxLength: 60,
    description: 'Nuevo username. UNIQUE GLOBAL. Si no se envía, no se modifica.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  username?: string;

  @ApiPropertyOptional({
    example: 'NuevaPasswordSegura1!',
    minLength: 8,
    maxLength: 128,
    description: 'Nueva password en texto plano. Se hashea con argon2id antes de persistir.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'password debe tener al menos 8 caracteres' })
  @MaxLength(128, { message: 'password no puede exceder 128 caracteres' })
  password?: string;
}
