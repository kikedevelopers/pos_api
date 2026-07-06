import type { Logger } from '@nestjs/common';

import type { Company } from '@/modules/companies/entities/company.entity';
import type { Employee } from '@/modules/employees/entities/employee.entity';
import type { User } from '@/modules/users/entities/user.entity';

import type { PermissionKey } from '@/modules/roles/internal/permission-catalog';

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
 * Reglas: igual que `userToAuthUserDto` + añade `created_at` ISO + los
 * `permissions` efectivos (resueltos por el caller con `RolesService`).
 */
export function userToUserProfileDto(
  user: User,
  logger: Logger,
  permissions: PermissionKey[],
): UserProfileDto {
  return {
    id: bigintToNumber(user.id, logger, 'User'),
    name: user.name,
    lastname: user.lastname ?? '',
    email: user.email ?? '',
    type: user.type,
    created_at: user.created_at.toISOString(),
    branches_enabled: user.branches_enabled ?? false,
    branches_allowed: user.branches_allowed ?? 0,
    // owner/superadmin ven márgenes/ganancias y caja siempre.
    can_view_profit: true,
    can_view_cash: true,
    can_view_product_margin: true,
    can_view_product_profit: true,
    permissions,
  };
}

/**
 * Proyecta un `Employee` al `UserProfileDto` de `GET /auth/profile`.
 *
 * Paridad con `placepos/auth.routes.ts:230` (path employee).
 *
 * `permissions` son los efectivos del empleado (rol personalizado o legacy),
 * resueltos por el caller con `RolesService`.
 */
export function employeeToUserProfileDto(
  employee: Employee,
  logger: Logger,
  permissions: PermissionKey[],
): UserProfileDto {
  return {
    id: bigintToNumber(employee.id, logger, 'Employee'),
    name: employee.name,
    lastname: '',
    email: employee.email ?? employee.username ?? '',
    type: 'employee',
    created_at: employee.created_at.toISOString(),
    // Los empleados no gestionan sucursales.
    branches_enabled: false,
    branches_allowed: 0,
    // Según su flag de configuración (POS). Default false.
    can_view_profit: employee.can_view_profit,
    can_view_cash: employee.can_view_cash,
    can_view_product_margin: employee.can_view_product_margin,
    can_view_product_profit: employee.can_view_product_profit,
    permissions,
  };
}

/**
 * Proyecta una `Company` al `CompanyProfileItemDto` de `GET /auth/profile`.
 *
 * Reglas:
 *   - `is_branch`: refleja el flag real de la company (false = negocio
 *     principal del owner; true = sucursal creada vía `POST /branches`).
 *   - `balance`: la entidad ya tiene `NumericTransformer` aplicado, pero
 *     forzamos `Number()` por seguridad si llegara a venir como string en
 *     algún path raw query.
 *   - `created_at` / `updated_at`: ISO 8601 string.
 */
export function companyToCompanyProfileItemDto(
  company: Company,
  logger: Logger,
  isActive = true,
): CompanyProfileItemDto {
  return {
    id: bigintToNumber(company.id, logger, 'Company'),
    name: company.name,
    is_branch: company.is_branch ?? false,
    balance: Number(company.balance),
    document_number: company.document_number ?? null,
    address: company.address ?? null,
    email: company.email ?? null,
    phone_number: company.phone_number ?? null,
    created_at: company.created_at.toISOString(),
    updated_at: company.updated_at.toISOString(),
    // Estado de la membresía del owner para esta company (multi-sucursal).
    is_active: isActive,
  };
}
