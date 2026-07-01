import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';

import type { AdjustEmployeeCashResult, SetEmployeeCashBaseResult } from './employees.service';
import { AdjustCashDto } from './dto/adjust-cash.dto';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import {
  EmployeeDetailResponseDto,
  EmployeeResponseDto,
  toEmployeeDetailResponseDto,
  toEmployeeResponseDto,
  toEmployeeResponseDtoFromEntity,
} from './dto/employee-response.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { SetCashBaseDto } from './dto/set-cash-base.dto';
import { ToggleLoginDto } from './dto/toggle-login.dto';
import { UpdateCredentialsDto } from './dto/update-credentials.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeesService } from './employees.service';

/**
 * Endpoints de gestión de employees. Espejo del contrato PlacePos
 * (`employees.routes.ts`).
 *
 * Autorización: TODOS los endpoints requieren `@Roles('owner')`. El
 * `manager` y el `employee` NO gestionan personal — sólo el owner.
 *
 * Multi-tenancy: `@CurrentCompany()` extrae el `company_id` del JWT y se
 * propaga a TODAS las queries del service. El payload del cliente nunca
 * incluye `company_id`.
 */
@ApiTags('employees')
@ApiBearerAuth('bearer')
@Controller('employees')
@Roles('owner')
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  // LECTURAS: `@RequirePermission('canAccessEmployees')` solo en los GET para que
  // un empleado con rol que conceda el módulo (p.ej. "Administrador") pueda VER
  // el listado/detalle (el RolesGuard delega al PermissionsGuard). Las MUTACIONES
  // (crear, credenciales, toggle-login, ajuste de caja) NO llevan la key y quedan
  // owner-only por el `@Roles('owner')` de clase — gestión sensible de personal.
  @Get()
  @RequirePermission('canAccessEmployees')
  @ApiOperation({
    summary: 'Listar employees de la company autenticada',
    description:
      'Por defecto devuelve solo empleados activos. Con `?includeArchived=true` incluye también los archivados.',
  })
  @ApiQuery({
    name: 'includeArchived',
    required: false,
    type: Boolean,
    description: 'Si es `true`, incluye empleados archivados. Por defecto solo activos.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [EmployeeResponseDto] })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  async findAll(
    @CurrentCompany() companyId: number,
    @Query() query: ListEmployeesQueryDto,
  ): Promise<EmployeeResponseDto[]> {
    const employees = await this.employeesService.findAll(companyId, query.includeArchived);
    return employees.map(toEmployeeResponseDto);
  }

  @Get(':id')
  @RequirePermission('canAccessEmployees')
  @ApiOperation({
    summary: 'Detalle de un employee + datos de su caja registradora',
    description:
      'Devuelve el employee + `cash_balance` y `base_amount` del turno abierto (0/0 si no tiene turno abierto). Paridad PlacePos `GET /employees/:id`.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: EmployeeDetailResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<EmployeeDetailResponseDto> {
    const result = await this.employeesService.findOne(id, companyId);
    return toEmployeeDetailResponseDto(result);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // Override del throttler global (100/min): 30/min para mitigar enumeración
  // cross-tenant del namespace UNIQUE GLOBAL de `username` (MED-3 auditor).
  // Un owner legítimo no crea 30 employees por minuto; un atacante con
  // credenciales válidas que intente sondear usernames sí lo notaría.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Crear employee' })
  @ApiBody({ type: CreateEmployeeDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: EmployeeResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Username ya está en uso (code: USERNAME_TAKEN)',
  })
  async create(
    @Body() dto: CreateEmployeeDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeesService.create(dto, companyId, {
      id: currentUser.user_id,
      // El service congela este string como snapshot. PlacePos guarda
      // `full_name` (concat de name+lastname).
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
    // En creación la caja siempre nace con balance/base = 0. Mapper sin
    // lookup adicional para no añadir un round-trip post-INSERT.
    return toEmployeeResponseDtoFromEntity(employee);
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Actualizar perfil del employee' })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateEmployeeDto })
  @ApiResponse({ status: HttpStatus.OK, type: EmployeeResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeDto,
    @CurrentCompany() companyId: number,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeesService.update(id, dto, companyId);
    // Re-lectura del detalle para incluir cash_balance/base_amount actuales
    // (paridad PlacePos: `PUT /employees/:id` devuelve el employee + caja).
    const detail = await this.employeesService.findOne(Number(employee.id), companyId);
    return toEmployeeDetailResponseDto(detail);
  }

  @Put(':id/credentials')
  @HttpCode(HttpStatus.OK)
  // Mismo rationale que `POST /employees`: mitigar enumeración cross-tenant
  // del namespace UNIQUE GLOBAL de `username` (MED-3 auditor). 30/min
  // suficiente para uso legítimo (rotación de credenciales).
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Actualizar username y/o password',
    description:
      'Al menos uno de los dos debe enviarse. `username` debe ser único GLOBAL. `password` se hashea con argon2id.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: UpdateCredentialsDto })
  @ApiResponse({ status: HttpStatus.OK, type: EmployeeResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Payload inválido o ambos campos ausentes',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Username ya está en uso (code: USERNAME_TAKEN)',
  })
  async updateCredentials(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCredentialsDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeesService.updateCredentials(
      id,
      dto,
      companyId,
      currentUser.user_id,
    );
    // Re-lectura del detalle para que el response incluya el resumen de
    // caja (paridad PlacePos).
    const detail = await this.employeesService.findOne(Number(employee.id), companyId);
    return toEmployeeDetailResponseDto(detail);
  }

  @Put(':id/toggle-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Habilitar o deshabilitar el acceso del employee al sistema',
    description: 'Si `enabled = true` y el employee no tiene credenciales asignadas, responde 422.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: ToggleLoginDto })
  @ApiResponse({ status: HttpStatus.OK, type: EmployeeResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'Habilitar login requiere credenciales configuradas',
  })
  async toggleLogin(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ToggleLoginDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeesService.toggleLogin(
      id,
      dto.enabled,
      companyId,
      currentUser.user_id,
    );
    // Re-lectura del detalle: tras OFF→ON el employee acaba de obtener su
    // User espejo y la caja recién creada; el cliente la espera en el
    // response (paridad PlacePos).
    const detail = await this.employeesService.findOne(Number(employee.id), companyId);
    return toEmployeeDetailResponseDto(detail);
  }

  @Put(':id/cash-register/base')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fijar `base_amount` (fondo fijo) de la caja del empleado',
    description:
      'Persiste el base_amount de la caja PERMANENTE del empleado (`cash_registers.base_amount`). NO genera movimiento financiero — es solo configuración. 400 si negativo o si el empleado no tiene login habilitado.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: SetCashBaseDto })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido o sin login' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'El empleado no tiene caja abierta',
  })
  async setCashBase(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetCashBaseDto,
    @CurrentCompany() companyId: number,
  ): Promise<SetEmployeeCashBaseResult> {
    return this.employeesService.setCashBase(id, dto.base_amount, companyId);
  }

  @Post(':id/cash-register/adjust')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Ajuste administrativo del balance de la caja del empleado',
    description:
      'Define cuánto DEBE quedar la caja. Calcula diff = target - current, registra CashRegisterLog (IN/OUT, affects_balance=true) y FinancialMovement (INCOME/EXPENSE, concept=ADJUSTMENT). Si diff = 0 es no-op idempotente.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiBody({ type: AdjustCashDto })
  @ApiResponse({ status: HttpStatus.CREATED })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Payload inválido' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'El empleado no tiene caja abierta',
  })
  async adjustCash(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdjustCashDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<AdjustEmployeeCashResult> {
    return this.employeesService.adjustCash(id, companyId, dto.target_balance, dto.reason, {
      id: currentUser.user_id,
      fullName: `${currentUser.name} ${currentUser.lastname}`.trim(),
    });
  }

  // ARCHIVAR / RESTAURAR: baja lógica del empleado. Owner-only SIN
  // `@RequirePermission` (como el ajuste de caja) — gestión sensible de
  // personal que ni siquiera un rol con el módulo employees puede ejecutar; el
  // RolesGuard NO delega a permisos y solo el owner pasa.
  @Put(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archivar (dar de baja lógica) un employee',
    description:
      'Setea `is_archived = true` y REVOCA el acceso (`login_enabled = false`) — un empleado archivado no puede iniciar sesión. NO borra su historia ni su usuario espejo. Idempotente: archivar un empleado ya archivado responde 200 sin error.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: EmployeeResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  async archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeesService.archive(id, companyId, currentUser.user_id);
    return toEmployeeResponseDtoFromEntity(employee);
  }

  @Put(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restaurar (revertir baja lógica) un employee',
    description:
      'Setea `is_archived = false`. NO re-habilita el login: el owner debe concederlo aparte con `PUT /employees/:id/toggle-login`. Idempotente: restaurar un empleado no archivado responde 200 sin error.',
  })
  @ApiParam({ name: 'id', type: 'integer', example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: EmployeeResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente o inválido' })
  @ApiResponse({ status: HttpStatus.FORBIDDEN, description: 'Rol distinto a owner' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Employee no encontrado' })
  async restore(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
    @CurrentUser() currentUser: AuthUser,
  ): Promise<EmployeeResponseDto> {
    const employee = await this.employeesService.restore(id, companyId, currentUser.user_id);
    return toEmployeeResponseDtoFromEntity(employee);
  }
}
