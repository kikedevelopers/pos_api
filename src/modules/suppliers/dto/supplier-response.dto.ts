import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Supplier, type SupplierPaymentAccount } from '@/modules/suppliers/entities/supplier.entity';

/**
 * Shape de respuesta del módulo suppliers. Espejo byte-por-byte de
 * `placepos/src/main/server/routes/suppliers.routes.ts:serializeSupplier`:
 *
 *   { id, legal_name, broker, address, phone, doc_number, email,
 *     accumulated_debt, credit_balance, is_archived, created_by, created_at }
 *
 *   - `id` como `number` (cast desde bigint string).
 *   - `accumulated_debt` y `credit_balance` como `number` (NumericTransformer).
 *   - `created_at` ISO 8601 string.
 */
export class SupplierResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Distribuidora Caracas C.A.' })
  legal_name!: string;

  @ApiPropertyOptional({ example: 'María García', nullable: true })
  broker!: string | null;

  @ApiPropertyOptional({ example: 'Av. Bolívar #45, Caracas', nullable: true })
  address!: string | null;

  @ApiPropertyOptional({ example: '+58 212 5551234', nullable: true })
  phone!: string | null;

  @ApiPropertyOptional({ example: 'J-12345678-9', nullable: true })
  doc_number!: string | null;

  @ApiPropertyOptional({ example: 'contacto@distcaracas.com', nullable: true })
  email!: string | null;

  @ApiProperty({
    example: 0,
    description: 'Cuentas por pagar acumuladas con el proveedor (>= 0).',
  })
  accumulated_debt!: number;

  @ApiProperty({
    example: 0,
    description: 'Saldo a favor de la company con el proveedor (>= 0).',
  })
  credit_balance!: number;

  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      properties: {
        entity_name: { type: 'string' },
        account_type: { type: 'string' },
        account_number: { type: 'string' },
        document_type: { type: 'string', enum: ['CC', 'NIT'] },
        document_number: { type: 'string' },
        agreement_number: { type: 'string', nullable: true },
      },
    },
    description:
      'Cuentas bancarias del proveedor. Array vacío si no se han configurado.',
  })
  payment_accounts!: SupplierPaymentAccount[];

  @ApiProperty({ example: false })
  is_archived!: boolean;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

/**
 * Convierte una entidad `Supplier` al DTO público. Único punto de proyección
 * — los controllers nunca exponen la entidad cruda.
 */
export function toSupplierResponseDto(supplier: Supplier): SupplierResponseDto {
  return {
    id: Number(supplier.id),
    legal_name: supplier.legal_name,
    broker: supplier.broker,
    address: supplier.address,
    phone: supplier.phone,
    doc_number: supplier.doc_number,
    email: supplier.email,
    accumulated_debt: supplier.accumulated_debt,
    credit_balance: supplier.credit_balance,
    payment_accounts: supplier.payment_accounts ?? [],
    is_archived: supplier.is_archived,
    created_by: supplier.created_by,
    created_at: supplier.created_at.toISOString(),
  };
}
