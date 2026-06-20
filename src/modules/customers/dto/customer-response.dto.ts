import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Customer, PersonType } from '@/modules/customers/entities/customer.entity';

/**
 * Shape de respuesta del módulo customers. Espejo del payload de
 * `customers.routes.ts` en PlacePos:
 *
 *   - `id` se serializa como `number` (pg entrega bigint como string; el
 *     mapper hace el cast).
 *   - `balance` se entrega como `number` (NumericTransformer ya lo castea
 *     en lectura; el cliente lo asume así en PlacePos).
 *   - `created_at` ISO 8601 string.
 *
 * Divergencia controlada vs PlacePos:
 *   - PlacePos NO expone `is_archived` para Customer. Lo añadimos porque
 *     existe el endpoint cloud `PUT /:id/archive`. Es un campo opcional
 *     adicional, no-breaking (el frontend ignora claves que no conoce).
 */
export class CustomerResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ enum: PersonType, example: PersonType.INDIVIDUAL })
  person_type!: PersonType;

  @ApiProperty({ example: 'Juan Pérez' })
  name!: string;

  @ApiPropertyOptional({ example: 'juan@ejemplo.com', nullable: true })
  email!: string | null;

  @ApiPropertyOptional({ example: '+58 412 1234567', nullable: true })
  phone!: string | null;

  @ApiPropertyOptional({ example: 'V-12345678', nullable: true })
  doc_number!: string | null;

  @ApiPropertyOptional({ example: 'Av. Principal #123, Caracas', nullable: true })
  address!: string | null;

  @ApiProperty({
    example: 0,
    description: 'SIGNED. >0: la company le debe al cliente. <0: el cliente le debe a la company.',
  })
  balance!: number;

  @ApiProperty({
    example: false,
    description:
      'Extensión cloud — PlacePos local no archiva customers. true ⇒ no aparece en listados activos.',
  })
  is_archived!: boolean;

  @ApiProperty({
    example: 0,
    description:
      'Saldo de anticipos del cliente (>= 0). Solo se incrementa al registrar un anticipo. Campo dedicado, distinto de balance.',
  })
  advance_balance!: number;

  @ApiProperty({
    example: 0,
    description:
      'Saldo de PUNTOS acumulados del cliente (>= 0, entero). Acumulación por compras de contado; el canje queda fuera de alcance.',
  })
  points!: number;

  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;
}

/**
 * Convierte una entidad `Customer` al DTO público. Único punto de proyección
 * — si alguien expone `Customer` crudo desde un controller, es un bug
 * (potencial fuga de joins eager-loaded).
 *
 * `id` y `Number(...)`: el bigint de pg llega como string. Lo casteamos a
 * number igual que en `Employee`. En la práctica los ids no se acercan a
 * `MAX_SAFE_INTEGER`.
 */
export function toCustomerResponseDto(customer: Customer): CustomerResponseDto {
  return {
    id: Number(customer.id),
    person_type: customer.person_type,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    doc_number: customer.doc_number,
    address: customer.address,
    balance: customer.balance,
    is_archived: customer.is_archived,
    advance_balance: customer.advance_balance,
    points: customer.points,
    created_by: customer.created_by,
    created_at: customer.created_at.toISOString(),
  };
}
