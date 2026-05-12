import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { Expense, ExpenseSourceType } from '../entities/expense.entity';

/**
 * Forma de un row de Expense expuesto al cliente. Espejo PlacePos: amounts y
 * timestamps serializados a number/ISO string. `company_id` se omite
 * (el cliente nunca lo necesita y no debe ver IDs cross-tenant).
 */
export class ExpenseResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Pago de luz mes de Mayo' })
  description!: string;

  @ApiProperty({ example: 150.5 })
  amount!: number;

  @ApiPropertyOptional({ example: 'UTILITIES' })
  category!: string | null;

  @ApiProperty({ example: 'bank' })
  source_type!: ExpenseSourceType;

  @ApiProperty({ example: 1 })
  source_id!: number;

  @ApiPropertyOptional({ example: 'Banco Provincial - 0001-0001' })
  source_name!: string | null;

  @ApiProperty({ example: '2026-05-12T10:00:00.000Z' })
  expense_date!: string;

  @ApiPropertyOptional({ example: 'Factura 12345' })
  notes!: string | null;

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco' })
  created_by!: string | null;

  @ApiPropertyOptional({ example: 7 })
  created_by_id!: number | null;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T10:00:01.234Z' })
  updated_at!: string;
}

/**
 * Serializa una `Expense` al shape de respuesta. Convierte bigints a number
 * y dates a ISO string. **Nunca expone `company_id`.**
 */
export function toExpenseResponseDto(expense: Expense): ExpenseResponseDto {
  return {
    id: Number(expense.id),
    description: expense.description,
    amount: Number(expense.amount),
    category: expense.category,
    source_type: expense.source_type,
    source_id: Number(expense.source_id),
    source_name: expense.source_name,
    expense_date: expense.expense_date.toISOString(),
    notes: expense.notes,
    is_archived: expense.is_archived,
    created_by: expense.created_by,
    created_by_id: expense.created_by_id !== null ? Number(expense.created_by_id) : null,
    created_at: expense.created_at.toISOString(),
    updated_at: expense.updated_at.toISOString(),
  };
}

/**
 * Payload de la respuesta de `GET /expenses`. Mantiene el shape PlacePos:
 * `expenses` + `total` + `totalAmount` + `activeCount`. Adicionalmente
 * exponemos `limit`/`offset` para que el cliente sepa la paginación
 * aplicada (el frontend legacy los ignora).
 */
export class ListExpensesResponseDto {
  @ApiProperty({ type: [ExpenseResponseDto] })
  expenses!: ExpenseResponseDto[];

  @ApiProperty({ example: 42, description: 'Total de rows devueltos en esta página.' })
  total!: number;

  @ApiProperty({ example: 1234.56, description: 'Suma de amounts de gastos NO archivados.' })
  totalAmount!: number;

  @ApiProperty({ example: 40, description: 'Cantidad de gastos con is_archived=false.' })
  activeCount!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
