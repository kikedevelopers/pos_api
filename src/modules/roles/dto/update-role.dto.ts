import { PartialType } from '@nestjs/swagger';

import { CreateRoleDto } from './create-role.dto';

/**
 * Payload de `PUT /roles/:id`.
 *
 * `PartialType` hace todos los campos opcionales (PUT idempotente con body
 * parcial). NO incluye `is_system`: el flag de rol de sistema NUNCA se cambia
 * vía API — el action lo ignora por construcción (sólo parchea
 * name/color/icon/permissions). El owner SÍ puede editar un rol de sistema
 * (p. ej. ajustar qué hace 'Cajero'), pero no convertirlo en/desde sistema.
 */
export class UpdateRoleDto extends PartialType(CreateRoleDto) {}
