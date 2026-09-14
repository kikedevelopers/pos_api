import { BadRequestException } from '@nestjs/common';

import { loadParentTaxRateId, resolveTaxRatePercent } from '../resolve-tax-rate.helper';

// El catálogo tax_rates es global; el helper solo lee la tarifa por id.
function managerReturning(tax: { rate: number } | null) {
  return {
    findOne: jest.fn().mockResolvedValue(tax),
  } as never;
}

describe('resolveTaxRatePercent', () => {
  it('null → 0 (Exento)', async () => {
    const manager = managerReturning(null);
    await expect(resolveTaxRatePercent(manager, null)).resolves.toBe(0);
    // Ni siquiera consulta el catálogo: null es Exento por definición.
    expect((manager as unknown as { findOne: jest.Mock }).findOne).not.toHaveBeenCalled();
  });

  it('undefined → 0 (Exento)', async () => {
    const manager = managerReturning(null);
    await expect(resolveTaxRatePercent(manager, undefined)).resolves.toBe(0);
  });

  it('id válido → tarifa del catálogo', async () => {
    const manager = managerReturning({ rate: 19 });
    await expect(resolveTaxRatePercent(manager, 1)).resolves.toBe(19);
  });

  it('id inexistente/inactivo → 400', async () => {
    const manager = managerReturning(null);
    await expect(resolveTaxRatePercent(manager, 999)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('loadParentTaxRateId', () => {
  it('devuelve el tax_rate_id del base (para que el hijo lo herede)', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue({ id: '1', tax_rate_id: '3' }) } as never;
    await expect(loadParentTaxRateId(manager, 1, 8)).resolves.toBe(3);
  });

  it('base sin tarifa (Exento) → null', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue({ id: '1', tax_rate_id: null }) } as never;
    await expect(loadParentTaxRateId(manager, 1, 8)).resolves.toBeNull();
  });

  it('base inexistente → null', async () => {
    const manager = { findOne: jest.fn().mockResolvedValue(null) } as never;
    await expect(loadParentTaxRateId(manager, 999, 8)).resolves.toBeNull();
  });
});
