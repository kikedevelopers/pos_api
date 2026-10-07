import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query de `GET /comandas`. Acepta `date` opcional (día COLOMBIANO a inspeccionar):
 *   - Sin `date` → el día actual (hora Colombia). La cocina siempre abre en "hoy".
 *   - Con `date` → ese día, para revisar si quedó algún pedido pendiente de un día
 *     anterior.
 *
 * Solo se valida el FORMATO aquí (regex `YYYY-MM-DD`); la validación semántica
 * (calendario real, rango) la hace `parseDateRange` en la action, igual que el
 * dashboard, para mantener los mensajes de error coincidentes.
 */
export class FindComandasQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-07',
    description: 'Día (hora Colombia) a listar. Default: hoy.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Formato de fecha inválido (YYYY-MM-DD)' })
  date?: string;
}
