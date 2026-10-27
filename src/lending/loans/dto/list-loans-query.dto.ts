import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

import { LOAN_STATUSES, type LoanStatus } from '../entities/loan.entity';

/** Query de `GET /loans`: por estado y/o por cliente. */
export class ListLoansQueryDto {
  @ApiPropertyOptional({ enum: LOAN_STATUSES })
  @IsOptional()
  @IsIn(LOAN_STATUSES)
  status?: LoanStatus;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  customer_id?: number;
}
