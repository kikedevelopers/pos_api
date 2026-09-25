import type { CustomerCategory } from '@/modules/customer-categories/entities/customer-category.entity';

import { toCustomerResponseDto } from '../dto/customer-response.dto';
import type { Customer } from '../entities/customer.entity';
import { PersonType } from '../entities/customer.entity';

/**
 * Tests de la proyección `toCustomerResponseDto` para el campo `category`.
 *
 * Verifica que:
 *   - `category_id` se castea a number (o null).
 *   - `category` anida { id, name } cuando la relación viene cargada.
 *   - `category` es null cuando no hay categoría o la relación no se cargó.
 */
describe('toCustomerResponseDto — categoría', () => {
  const base: Customer = {
    id: '1',
    company_id: '1',
    person_type: PersonType.INDIVIDUAL,
    name: 'Juan',
    email: null,
    phone: null,
    doc_number: null,
    address: null,
    category_id: null,
    category: null,
    type_document_identification_id: null,
    dv: null,
    type_regime_id: null,
    type_liability_id: null,
    municipality_id: null,
    merchant_registration: null,
    balance: 0,
    is_archived: false,
    advance_balance: 0,
    points: 0,
    created_by: 'Owner',
    created_by_id: '1',
    created_at: new Date('2026-09-25T14:30:00.000Z'),
    updated_at: new Date('2026-09-25T14:30:00.000Z'),
  } as Customer;

  it('category null cuando el cliente no tiene categoría', () => {
    const dto = toCustomerResponseDto(base);
    expect(dto.category_id).toBeNull();
    expect(dto.category).toBeNull();
  });

  it('anida { id, name } cuando la relación viene cargada', () => {
    const customer: Customer = {
      ...base,
      category_id: '3',
      category: { id: '3', name: 'Cliente Redes Sociales' } as CustomerCategory,
    };
    const dto = toCustomerResponseDto(customer);
    expect(dto.category_id).toBe(3);
    expect(dto.category).toEqual({ id: 3, name: 'Cliente Redes Sociales' });
  });

  it('category null si hay category_id pero la relación no se cargó', () => {
    const customer: Customer = {
      ...base,
      category_id: '3',
      category: undefined as unknown as CustomerCategory | null,
    };
    const dto = toCustomerResponseDto(customer);
    expect(dto.category_id).toBe(3);
    expect(dto.category).toBeNull();
  });
});
