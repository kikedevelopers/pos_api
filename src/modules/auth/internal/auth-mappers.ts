import type { Logger } from '@nestjs/common';

import type { Company } from '@/modules/companies/entities/company.entity';
import type { Employee } from '@/modules/employees/entities/employee.entity';
import type { User } from '@/modules/users/entities/user.entity';

import type { AuthUserDto, CompanyProfileDto } from '../dto/auth-response.dto';

import { bigintToNumber } from './bigint-to-number';

/**
 * Proyecta un `User` al `AuthUserDto` del contrato PlacePos.
 */
export function userToAuthUserDto(user: User, logger: Logger): AuthUserDto {
  return {
    id: bigintToNumber(user.id, logger, 'User'),
    name: user.name,
    lastname: user.lastname,
    email: user.email,
    type: user.type,
  };
}

/**
 * Proyecta un `Employee` al `AuthUserDto` del contrato PlacePos.
 *
 * Decisiones (documentadas en el plan de Fase 2 + auditoría de seguridad):
 *
 *   - `lastname` se devuelve como `''` (string vacío) — NUNCA `null`. El
 *     contrato declara `lastname: string` en el shape original de PlacePos.
 *     Mantener `null` haría que el frontend que concatene `name + ' ' +
 *     lastname` muestre "null". El employee real no tiene lastname; el
 *     string vacío es la representación neutra.
 *
 *   - `email`: paridad PlacePos. El cliente local sirve `email: email ??
 *     username ?? ''` para que el campo SIEMPRE sea string (nunca null en
 *     este path). El DTO `AuthUserDto.email` aún admite `string | null`
 *     porque es compartido con el path User; aquí garantizamos que el valor
 *     concreto sea siempre `string`.
 *
 *   - `type`: paridad PlacePos. SIEMPRE `'employee'` literal. El rol real
 *     (`manager` | `employee`) vive en `employees.role` y se consulta por
 *     `JWT.user_id` cuando aplique.
 */
export function employeeToAuthUserDto(employee: Employee, logger: Logger): AuthUserDto {
  return {
    id: bigintToNumber(employee.id, logger, 'Employee'),
    name: employee.name,
    lastname: '',
    email: employee.email ?? employee.username ?? '',
    // Paridad PlacePos: literal, no `employee.role`.
    type: 'employee',
  };
}

export function companyToCompanyProfileDto(company: Company, logger: Logger): CompanyProfileDto {
  return {
    id: bigintToNumber(company.id, logger, 'Company'),
    name: company.name,
    document_number: company.document_number,
    address: company.address,
    email: company.email,
    phone_number: company.phone_number,
    break_even_amount: company.break_even_amount,
    break_even_period_days: company.break_even_period_days,
  };
}
