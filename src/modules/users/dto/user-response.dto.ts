import { ApiProperty } from '@nestjs/swagger';

import type { UserType } from '@/common/types/jwt-payload.type';

import type { User } from '../entities/user.entity';

/**
 * Shape de respuesta de los endpoints `/users/me`. Espeja el `AuthUserDto`
 * + `created_at` para que el cliente actualice su cache local.
 *
 * NO expone `password` ni `balance` ni `company_id`.
 */
export class UserResponseDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'Kike' })
  name!: string;

  @ApiProperty({ example: 'Pacheco' })
  lastname!: string;

  @ApiProperty({ example: 'kike@ares.pos' })
  email!: string;

  @ApiProperty({ example: 'owner', enum: ['superadmin', 'owner', 'manager', 'employee'] })
  type!: UserType;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  updated_at!: string;
}

/**
 * Serializa un `User` al shape público. Nunca expone `password`,
 * `balance` ni `company_id`.
 */
export function toUserResponseDto(user: User): UserResponseDto {
  return {
    id: Number(user.id),
    name: user.name,
    lastname: user.lastname ?? '',
    email: user.email,
    type: user.type,
    created_at: user.created_at.toISOString(),
    updated_at: user.updated_at.toISOString(),
  };
}
