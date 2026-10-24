import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/** Query de `GET /loan-plans?include_archived=true`. Sin él, solo los activos. */
export class ListLoanPlansQueryDto {
  @ApiPropertyOptional({ example: false })
  @IsOptional()
  // `?include_archived=true` llega como string; cualquier otro valor es false.
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  include_archived?: boolean;
}
