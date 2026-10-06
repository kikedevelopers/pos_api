import type { Logger } from '@nestjs/common';

import type { Employee } from '@/modules/employees/entities/employee.entity';
import type { User } from '@/modules/users/entities/user.entity';

import type { Company } from '@/modules/companies/entities/company.entity';

import {
  companyToCompanyProfileItemDto,
  employeeToUserProfileDto,
  userToUserProfileDto,
} from '../auth-mappers';

const logger = { warn: jest.fn(), error: jest.fn() } as unknown as Logger;

describe('auth-mappers · can_view_profit en UserProfileDto (paridad PlacePos)', () => {
  it('owner → can_view_profit=true (siempre, aunque no sea un empleado)', () => {
    const user = {
      id: '1',
      name: 'Kike',
      lastname: 'Pacheco',
      email: 'kike@ares.pos',
      type: 'owner',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      branches_enabled: true,
      branches_allowed: 2,
    } as unknown as User;

    expect(userToUserProfileDto(user, logger, []).can_view_profit).toBe(true);
  });

  it('empleado con can_view_profit=true lo propaga al perfil', () => {
    const employee = {
      id: '5',
      name: 'Ana',
      email: 'ana@ares.pos',
      username: 'ana',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      can_view_profit: true,
    } as unknown as Employee;

    expect(employeeToUserProfileDto(employee, logger, []).can_view_profit).toBe(true);
  });

  it('empleado con can_view_profit=false lo propaga al perfil', () => {
    const employee = {
      id: '5',
      name: 'Ana',
      email: 'ana@ares.pos',
      username: 'ana',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      can_view_profit: false,
    } as unknown as Employee;

    expect(employeeToUserProfileDto(employee, logger, []).can_view_profit).toBe(false);
  });
});

describe('auth-mappers · can_view_cash en UserProfileDto (paridad PlacePos)', () => {
  it('owner → can_view_cash=true siempre', () => {
    const user = {
      id: '1',
      name: 'Kike',
      lastname: 'Pacheco',
      email: 'kike@ares.pos',
      type: 'owner',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      branches_enabled: true,
      branches_allowed: 2,
    } as unknown as User;

    expect(userToUserProfileDto(user, logger, []).can_view_cash).toBe(true);
  });

  it('empleado propaga su flag can_view_cash (true y false)', () => {
    const base = {
      id: '5',
      name: 'Ana',
      email: 'ana@ares.pos',
      username: 'ana',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      can_view_profit: false,
    };

    expect(
      employeeToUserProfileDto({ ...base, can_view_cash: true } as unknown as Employee, logger, [])
        .can_view_cash,
    ).toBe(true);
    expect(
      employeeToUserProfileDto({ ...base, can_view_cash: false } as unknown as Employee, logger, [])
        .can_view_cash,
    ).toBe(false);
  });
});

describe('auth-mappers · receives_shared_inventory en CompanyProfileItemDto', () => {
  const company = {
    id: '11',
    name: 'Esencia & Grano - la 28',
    is_branch: true,
    balance: '0',
    document_number: null,
    address: null,
    email: null,
    phone_number: null,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    updated_at: new Date('2025-01-01T00:00:00.000Z'),
    electronic_billing_enabled: false,
  } as unknown as Company;

  it('default false cuando el caller no lo resuelve', () => {
    const dto = companyToCompanyProfileItemDto(company, logger);
    expect(dto.receives_shared_inventory).toBe(false);
  });

  it('true cuando el caller indica que la sucursal recibe inventario compartido', () => {
    const dto = companyToCompanyProfileItemDto(company, logger, true, true);
    expect(dto.receives_shared_inventory).toBe(true);
  });

  it('false explícito cuando el caller lo resuelve como no compartido (p. ej. clonado)', () => {
    const dto = companyToCompanyProfileItemDto(company, logger, true, false);
    expect(dto.receives_shared_inventory).toBe(false);
  });
});

describe('auth-mappers · subpermisos del configurador (margen/ganancia del producto)', () => {
  it('owner → ambos subpermisos true siempre', () => {
    const user = {
      id: '1',
      name: 'Kike',
      lastname: 'Pacheco',
      email: 'kike@ares.pos',
      type: 'owner',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      branches_enabled: true,
      branches_allowed: 2,
    } as unknown as User;

    const profile = userToUserProfileDto(user, logger, []);
    expect(profile.can_view_product_margin).toBe(true);
    expect(profile.can_view_product_profit).toBe(true);
  });

  it('empleado propaga cada subpermiso de forma independiente', () => {
    const base = {
      id: '5',
      name: 'Ana',
      email: 'ana@ares.pos',
      username: 'ana',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
      can_view_profit: false,
      can_view_cash: false,
    };

    const profile = employeeToUserProfileDto(
      {
        ...base,
        can_view_product_margin: true,
        can_view_product_profit: false,
      } as unknown as Employee,
      logger,
      [],
    );
    expect(profile.can_view_product_margin).toBe(true);
    expect(profile.can_view_product_profit).toBe(false);
  });
});

describe('auth-mappers · pos_mode en CompanyProfileItemDto', () => {
  const base = {
    id: '8',
    name: 'Esencia & Grano',
    is_branch: false,
    balance: '0',
    document_number: null,
    address: null,
    email: null,
    phone_number: null,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
    updated_at: new Date('2025-01-01T00:00:00.000Z'),
    electronic_billing_enabled: false,
  };
  const project = (pos_mode?: unknown) =>
    companyToCompanyProfileItemDto({ ...base, pos_mode } as unknown as Company, logger).pos_mode;

  it("propaga 'retail'", () => {
    expect(project('retail')).toBe('retail');
  });

  it("propaga 'restaurant'", () => {
    expect(project('restaurant')).toBe('restaurant');
  });

  it("cae en 'retail' si la company no trae el campo", () => {
    expect(project(undefined)).toBe('retail');
    expect(project(null)).toBe('retail');
  });

  it("cae en 'retail' ante un valor desconocido (el negocio nunca queda sin POS)", () => {
    expect(project('bar')).toBe('retail');
    expect(project('RESTAURANT')).toBe('retail');
  });
});
