import type { Logger } from '@nestjs/common';

import type { Employee } from '@/modules/employees/entities/employee.entity';
import type { User } from '@/modules/users/entities/user.entity';

import { employeeToUserProfileDto, userToUserProfileDto } from '../auth-mappers';

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
