import type { Logger } from '@nestjs/common';

import type { Company } from '@/modules/companies/entities/company.entity';
import type { Employee } from '@/modules/employees/entities/employee.entity';
import type { User } from '@/modules/users/entities/user.entity';

import type { AuthUserDto, CompanyProfileItemDto, UserProfileDto } from '../dto/auth-response.dto';

import { bigintToNumber } from './bigint-to-number';

/**
 * Proyecta un `User` al `AuthUserDto` del contrato PlacePos.
 *
 * `email` y `lastname` SIEMPRE se entregan como string (nunca null) para
 * alinear con `LoginResponse.user` del cliente (`email: string`,
 * `lastname: string`). Si el storage tiene null, se proyecta a `''`.
 */
export function userToAuthUserDto(user: User, logger: Logger): AuthUserDto {
  return {
    id: bigintToNumber(user.id, logger, 'User'),
    name: user.name,
    lastname: user.lastname ?? '',
    email: user.email ?? '',
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
 *     username ?? ''` para que el campo SIEMPRE sea string. Aquí
 *     replicamos: `email || username || ''`.
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

/**
 * Proyecta un `User` al `UserProfileDto` de `GET /auth/profile`.
 *
 * Reglas: igual que `userToAuthUserDto` + añade `created_at` ISO.
 */
export function userToUserProfileDto(user: User, logger: Logger): UserProfileDto {
  return {
    id: bigintToNumber(user.id, logger, 'User'),
    name: user.name,
    lastname: user.lastname ?? '',
    email: user.email ?? '',
    type: user.type,
    created_at: user.created_at.toISOString(),
  };
}

/**
 * Proyecta un `Employee` al `UserProfileDto` de `GET /auth/profile`.
 *
 * Paridad con `placepos/auth.routes.ts:230` (path employee).
 */
export function employeeToUserProfileDto(employee: Employee, logger: Logger): UserProfileDto {
  return {
    id: bigintToNumber(employee.id, logger, 'Employee'),
    name: employee.name,
    lastname: '',
    email: employee.email ?? employee.username ?? '',
    type: 'employee',
    created_at: employee.created_at.toISOString(),
  };
}

/**
 * Proyecta una `Company` al `CompanyProfileItemDto` de `GET /auth/profile`.
 *
 * Reglas:
 *   - `is_branch`: SIEMPRE `false` en CLOUD (sin sucursales en esta fase).
 *   - `balance`: la entidad ya tiene `NumericTransformer` aplicado, pero
 *     forzamos `Number()` por seguridad si llegara a venir como string en
 *     algún path raw query.
 *   - `created_at` / `updated_at`: ISO 8601 string.
 */
export function companyToCompanyProfileItemDto(
  company: Company,
  logger: Logger,
): CompanyProfileItemDto {
  return {
    id: bigintToNumber(company.id, logger, 'Company'),
    name: company.name,
    is_branch: false,
    balance: Number(company.balance),
    document_number: company.document_number ?? null,
    address: company.address ?? null,
    email: company.email ?? null,
    phone_number: company.phone_number ?? null,
    created_at: company.created_at.toISOString(),
    updated_at: company.updated_at.toISOString(),
  };
}
