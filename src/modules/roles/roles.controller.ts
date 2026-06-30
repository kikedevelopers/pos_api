import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { Roles } from '@/common/decorators/roles.decorator';

import { CreateRoleDto } from './dto/create-role.dto';
import { RoleResponseDto, roleRowToResponseDto, roleToResponseDto } from './dto/role-response.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RolesService } from './roles.service';

/**
 * Endpoints de gestión de roles personalizados (catálogo de acceso a módulos).
 *
 * Autorización: TODOS los endpoints exigen `@Roles('owner')` a nivel de clase.
 * Sólo el owner administra los roles de su company. El `manager`/`employee`
 * nunca acceden.
 *
 * Multi-tenancy: `@CurrentCompany()` extrae el `company_id` del JWT y se
 * propaga a TODAS las queries del service; el payload del cliente nunca incluye
 * `company_id`.
 */
@ApiTags('roles')
@ApiBearerAuth('bearer')
@Controller('roles')
@Roles('owner')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar roles de la company (con employee_count)',
    description: 'Orden: roles de sistema primero, luego por nombre.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [RoleResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  async findAll(@CurrentCompany() companyId: number): Promise<RoleResponseDto[]> {
    const rows = await this.rolesService.list(companyId);
    return rows.map(roleRowToResponseDto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crear rol personalizado' })
  @ApiBody({ type: CreateRoleDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: RoleResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Nombre de rol ya existe en la company (code: ROLE_NAME_TAKEN)',
  })
  async create(
    @Body() dto: CreateRoleDto,
    @CurrentCompany() companyId: number,
  ): Promise<RoleResponseDto> {
    const role = await this.rolesService.create(dto, companyId);
    // Rol recién creado: ningún empleado asignado todavía.
    return roleToResponseDto(role, 0);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Editar rol (name/color/icon/permissions)',
    description: 'Permitido también sobre roles de sistema. El flag `is_system` nunca se modifica.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateRoleDto })
  @ApiResponse({ status: HttpStatus.OK, type: RoleResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Rol no encontrado' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Nombre de rol ya existe en la company (code: ROLE_NAME_TAKEN)',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoleDto,
    @CurrentCompany() companyId: number,
  ): Promise<RoleResponseDto> {
    const { role, employeeCount } = await this.rolesService.update(id, dto, companyId);
    return roleToResponseDto(role, employeeCount);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Eliminar rol personalizado',
    description: 'Sólo roles no-sistema. Los empleados con ese rol quedan sin rol (FK SET NULL).',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, description: 'Rol eliminado (payload: null)' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Rol no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'No se puede eliminar un rol de sistema',
  })
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<null> {
    await this.rolesService.delete(id, companyId);
    // ResponseWrapperInterceptor convierte `null` en `{ success: true, payload: null }`.
    return null;
  }
}
