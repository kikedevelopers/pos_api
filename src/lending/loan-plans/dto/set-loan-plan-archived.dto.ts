import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** Payload de `PUT /loan-plans/:id/archive`: archivar (true) o restaurar (false). */
export class SetLoanPlanArchivedDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  is_archived!: boolean;
}
