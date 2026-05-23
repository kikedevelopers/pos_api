import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserResponseDto, toUserResponseDto } from './dto/user-response.dto';
import { UsersService } from './users.service';

/**
 * Endpoints `/users/me` — gestión por parte del usuario sobre su propia
 * cuenta.
 *
 * PlacePos local NO expone `/users` explícito (la edición del owner vive en
 * `companies.routes.ts` para datos del negocio + el cambio de password en un
 * IPC controller). Aquí, en CLOUD, exponemos endpoints HTTP para que el
 * cliente pueda gestionar email/nombre/password del owner sobre HTTPS.
 *
 * Reglas:
 *   - Solo `owner` accede a estos endpoints. Los empleados (`manager`,
 *     `employee`) editan sus credenciales en `/employees/:id/credentials` —
 *     ese módulo ya vive en `EmployeesModule`.
 *   - El JWT define `user_id` + `company_id`. El controller jamás acepta
 *     un id en la URL — siempre se actúa sobre el usuario autenticado.
 *   - GET espeja `GET /auth/me` pero retorna el shape de `UserResponseDto`
 *     (con `created_at` y `updated_at`) que el frontend cachea.
 *
 * Anti-IDOR: el decorador `@CurrentCompany()` ya rechaza superadmin. El
 * `@Roles('owner')` filtra manager/employee — superadmin queda fuera por
 * doble vía.
 */
@ApiTags('users')
@ApiBearerAuth('bearer')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // --------------------------------------------------------------------------
  // GET /users/me
  // --------------------------------------------------------------------------

  @Get('me')
  @Roles('owner')
  @ApiOperation({
    summary: 'Perfil del owner autenticado.',
    description:
      'Espejo extendido de `GET /auth/me`: incluye `created_at` y `updated_at` ' +
      'para que el cliente cachee el row completo de `users`. Solo accesible al `owner` ' +
      '(employees y superadmin no aplican).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: UserResponseDto })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Usuario no encontrado' })
  async getMe(
    @CurrentUser() authUser: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<UserResponseDto> {
    // Defensa explícita: el JWT podría provenir de un Employee con
    // `account='employee'`. Aunque `@Roles('owner')` ya lo rechaza, marcamos
    // el invariante para que cualquier cambio futuro en RolesGuard no
    // exponga este endpoint a empleados.
    if (authUser.account !== 'user') {
      throw new ForbiddenException('Solo el owner puede consultar /users/me');
    }
    const user = await this.usersService.findMe(authUser.user_id, companyId);
    return toUserResponseDto(user);
  }

  // --------------------------------------------------------------------------
  // PUT /users/me
  // --------------------------------------------------------------------------

  @Put('me')
  @HttpCode(HttpStatus.OK)
  @Roles('owner')
  @ApiOperation({
    summary: 'Actualizar perfil del owner (nombre, apellido, email).',
    description:
      'Update parcial. El `email` debe ser único global; si choca con otro ' +
      'usuario devuelve 409 `EMAIL_TAKEN`. No permite cambiar `password`, ' +
      '`type`, `balance` ni `company_id` — endpoints específicos para password.',
  })
  @ApiBody({ type: UpdateMeDto })
  @ApiResponse({ status: HttpStatus.OK, type: UserResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Email ya registrado por otro usuario (code: EMAIL_TAKEN)',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Usuario no encontrado' })
  async updateMe(
    @Body() dto: UpdateMeDto,
    @CurrentUser() authUser: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<UserResponseDto> {
    if (authUser.account !== 'user') {
      throw new ForbiddenException('Solo el owner puede actualizar /users/me');
    }
    const user = await this.usersService.updateMe(authUser.user_id, companyId, dto);
    return toUserResponseDto(user);
  }

  // --------------------------------------------------------------------------
  // PUT /users/me/password
  // --------------------------------------------------------------------------

  @Put('me/password')
  @HttpCode(HttpStatus.OK)
  @Roles('owner')
  @ApiOperation({
    summary: 'Cambiar la contraseña del owner autenticado.',
    description:
      'Requiere `current_password` para validar la identidad. La nueva ' +
      'contraseña se hashea con argon2id. Los JWT vigentes NO se invalidan: ' +
      'el cliente debe re-loguear para refrescar.',
  })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: HttpStatus.OK, description: 'Password actualizado' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o passwords no coinciden',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'current_password incorrecto',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Usuario no encontrado' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() authUser: AuthUser,
    @CurrentCompany() companyId: number,
  ): Promise<{ updated: true }> {
    if (authUser.account !== 'user') {
      throw new ForbiddenException(
        'Solo el owner puede cambiar la contraseña vía /users/me/password',
      );
    }
    await this.usersService.changePassword(authUser.user_id, companyId, dto);
    return { updated: true };
  }
}
