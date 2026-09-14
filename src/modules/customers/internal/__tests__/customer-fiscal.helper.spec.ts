import type { CreateCustomerDto } from '../../dto/create-customer.dto';
import type { UpdateCustomerDto } from '../../dto/update-customer.dto';
import { buildFiscalPatch, extractFiscalFields, hasAnyFiscalField } from '../customer-fiscal.helper';

describe('customer-fiscal.helper', () => {
  describe('hasAnyFiscalField', () => {
    it('false cuando no hay ningún campo fiscal', () => {
      expect(hasAnyFiscalField({ name: 'X' } as CreateCustomerDto)).toBe(false);
    });

    it('true con un id fiscal', () => {
      expect(
        hasAnyFiscalField({ name: 'X', type_document_identification_id: 6 } as CreateCustomerDto),
      ).toBe(true);
    });

    it('true con dv o matrícula (texto)', () => {
      expect(hasAnyFiscalField({ name: 'X', dv: '3' } as CreateCustomerDto)).toBe(true);
      expect(
        hasAnyFiscalField({ name: 'X', merchant_registration: '0001' } as CreateCustomerDto),
      ).toBe(true);
    });

    it('false cuando los textos vienen vacíos/espacios', () => {
      expect(
        hasAnyFiscalField({ dv: '   ', merchant_registration: '' } as unknown as CreateCustomerDto),
      ).toBe(false);
    });

    it('false cuando los ids vienen null (limpiar no es operación de FE)', () => {
      expect(
        hasAnyFiscalField({
          type_document_identification_id: null,
          municipality_id: null,
        } as unknown as UpdateCustomerDto),
      ).toBe(false);
    });
  });

  describe('extractFiscalFields (create)', () => {
    it('ausencia total → todos null', () => {
      expect(extractFiscalFields({ name: 'X' } as CreateCustomerDto)).toEqual({
        type_document_identification_id: null,
        dv: null,
        type_regime_id: null,
        type_liability_id: null,
        municipality_id: null,
        merchant_registration: null,
      });
    });

    it('normaliza textos (trim, vacío→null) y copia ids', () => {
      expect(
        extractFiscalFields({
          name: 'X',
          type_document_identification_id: 6,
          dv: '3',
          type_regime_id: 1,
          type_liability_id: 7,
          municipality_id: 149,
          merchant_registration: '  0001-23  ',
        } as CreateCustomerDto),
      ).toEqual({
        type_document_identification_id: 6,
        dv: '3',
        type_regime_id: 1,
        type_liability_id: 7,
        municipality_id: 149,
        merchant_registration: '0001-23',
      });
    });
  });

  describe('buildFiscalPatch (update)', () => {
    it('solo incluye las claves DEFINIDAS (no nullifica lo no enviado)', () => {
      expect(buildFiscalPatch({ municipality_id: 149 } as UpdateCustomerDto)).toEqual({
        municipality_id: 149,
      });
    });

    it('respeta null explícito (limpiar un campo)', () => {
      expect(
        buildFiscalPatch({ type_liability_id: null } as unknown as UpdateCustomerDto),
      ).toEqual({ type_liability_id: null });
    });

    it('DTO sin fiscales → patch vacío', () => {
      expect(buildFiscalPatch({ name: 'X' } as UpdateCustomerDto)).toEqual({});
    });

    it('texto en blanco → null', () => {
      expect(buildFiscalPatch({ merchant_registration: '   ' } as UpdateCustomerDto)).toEqual({
        merchant_registration: null,
      });
    });
  });
});
