import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

/**
 * Body de `PATCH /sales/:id/assign` — compartir un pedido (retail) con un
 * empleado para que lo aliste, o quitar la asignación.
 *
 *   - `assigned_to_user_id: <id>` → asigna el pedido a ese empleado (users.id
 *     del espejo). Debe ser un empleado de la company con acceso al sistema
 *     (login activo, no archivado) y distinto del creador del pedido.
 *   - `assigned_to_user_id: null` → quita la asignación.
 *
 * snake_case en el contrato de entrada (como `table_id`/`salon_id`).
 */
export class AssignOrderDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 42,
    description:
      'users.id del empleado al que se comparte el pedido, o null para quitar la asignación.',
  })
  @IsOptional()
  // Permite null explícito (quitar asignación); si trae valor, entero positivo.
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  assigned_to_user_id!: number | null;
}
