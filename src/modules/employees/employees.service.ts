import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { QueryFailedError, type Repository } from 'typeorm';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';

import type { CreateEmployeeDto } from './dto/create-employee.dto';
import type { UpdateCredentialsDto } from './dto/update-credentials.dto';
import type { UpdateEmployeeDto } from './dto/update-employee.dto';
import { Employee } from './entities/employee.entity';

/**
 * Postgres SQLSTATE para `unique_violation`. Lo detectamos al crear o
 * actualizar credenciales para traducir la race condition `username-tomado`
 * a un 409 con `code = USERNAME_TAKEN`.
 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Nombre del CHECK constraint en DB que enforza:
 *   login_enabled = true ⇒ username NOT NULL AND password NOT NULL
 *
 * El service lo valida en pre-flight, pero si un escenario raro lo viola
 * (ej. update parcial concurrente), Postgres rechaza y atrapamos el error
 * por nombre del constraint para devolver un 400 con mensaje legible.
 */
const CHK_LOGIN_REQUIRES_CREDENTIALS = 'chk_employees_login_requires_credentials';

/**
 * Nombre del UNIQUE index parcial sobre `username` (GLOBAL, no per-company).
 * Justificación de la excepción a multi-tenant en la migración y en la skill
 * `multi-tenant-rules`. Lo detectamos por nombre para no confundirlo con un
 * UNIQUE de otra tabla en el mismo catch genérico.
 */
const IDX_USERNAME_UNIQUE = 'idx_employees_username_unique';

/**
 * Datos del owner creador que el controller propaga al service. Evita pasar
 * el `AuthUser` completo (que tiene más campos) y mantiene la firma del
 * service desacoplada de la forma del JWT.
 */
export interface EmployeeCreator {
  id: number;
  fullName: string;
}

/**
 * `EmployeesService` — CRUD de empleados + lookup global por username para
 * el login dual (`AuthService.login`).
 *
 * Multi-tenancy: TODA query (excepto `findByUsername`, ver doc inline)
 * filtra por `company_id`. El service nunca confía en el payload — el
 * controller le pasa el `companyId` que el guard extrajo del JWT.
 */
@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(
    @InjectRepository(Employee)
    private readonly repo: Repository<Employee>,
  ) {}

  /**
   * Lista employees ACTIVOS (`is_archived = false`) de una company, ordenados
   * por `created_at DESC`. Endpoint `GET /employees`.
   *
   * Paridad PlacePos: espeja `placepos/src/main/server/routes/employees.routes.ts`
   * (línea 58 — `ORDER BY created_at DESC`). El frontend asume orden de
   * creación descendente (más recientes arriba); cambiarlo por `name ASC`
   * reordena la lista visible y rompe la regla #1 del proyecto.
   */
  async findAll(companyId: number): Promise<Employee[]> {
    return this.repo.find({
      where: { company_id: String(companyId), is_archived: false },
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Lookup por id dentro de la company. Si no existe O pertenece a otra
   * company, lanza `NotFoundException`. **No** se distingue entre los dos
   * casos: el atacante no debe poder enumerar ids existentes en otras
   * companies por diferencia de status (404 vs 403).
   *
   * NOTA: incluye archivados (no filtra `is_archived`). Las acciones de
   * update/credentials/toggle/archive operan sobre activos y archivados;
   * el listado público sí filtra.
   */
  async findOne(id: number, companyId: number): Promise<Employee> {
    const employee = await this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
    });
    if (!employee) {
      throw new NotFoundException('Empleado no encontrado');
    }
    return employee;
  }

  /**
   * Lookup GLOBAL por `username`. **EXCEPCIÓN intencional a multi-tenant**:
   *
   *   `POST /auth/user` recibe `{ username, password }` sin tenant ID. Como
   *   `employees.username` es UNIQUE GLOBAL (analogía con `users.email`), el
   *   lookup necesario para el login NO puede filtrar por `company_id` — la
   *   company se RESUELVE a partir del employee encontrado.
   *
   *   Defensa en profundidad anti-enumeración: el caller (`AuthService.login`)
   *   nunca devuelve un mensaje distinto entre "username no existe" y
   *   "username existe pero password mal". Ambos casos se traducen al mismo
   *   `UnauthorizedException("Credenciales inválidas")`.
   *
   * Filtra `is_archived = false` y `login_enabled = true`: un employee
   * archivado o sin login habilitado NO debe poder autenticarse.
   *
   * Devuelve TODAS las columnas, incluido `password` — el caller lo necesita
   * para `argon2.verify`. El controller jamás recibe esta entidad cruda;
   * solo el `AuthService` la consume internamente.
   */
  async findByUsername(username: string): Promise<Employee | null> {
    return this.repo.findOne({
      where: { username, is_archived: false, login_enabled: true },
    });
  }

  /**
   * Crea un employee. Reglas:
   *
   *   - Si `login_enabled = true` y falta `username` o `password`, lanza 400
   *     pre-flight (el DTO también lo valida con `@ValidateIf`, pero esta es
   *     una red de seguridad por si el caller futuro envía a este service
   *     fuera del flujo HTTP).
   *
   *   - Si `login_enabled = false`, ignora `username`/`password` recibidos.
   *
   *   - `username` colisionado → 409 con `code: USERNAME_TAKEN`. Detección
   *     por catch de `QueryFailedError` con el nombre del índice.
   *
   *   - `company_id`, `created_by`, `created_by_id` se asignan desde el
   *     parámetro `createdBy` y `companyId` — NUNCA del DTO.
   */
  async create(
    dto: CreateEmployeeDto,
    companyId: number,
    createdBy: EmployeeCreator,
  ): Promise<Employee> {
    // Pre-flight: red de seguridad. El DTO ya lo cubre con @ValidateIf, pero
    // si alguien invoca el service directamente (test, queue worker), esto
    // protege la invariante del CHECK constraint.
    if (dto.login_enabled === true && (!dto.username || !dto.password)) {
      throw new BadRequestException('Username y password son requeridos para habilitar login');
    }

    const hashedPassword =
      dto.login_enabled === true && dto.password
        ? await argon2.hash(dto.password, ARGON2_OPTIONS)
        : null;

    const employee = this.repo.create({
      company_id: String(companyId),
      name: dto.name,
      phone: dto.phone ?? null,
      email: dto.email ?? null,
      address: dto.address ?? null,
      role: dto.role,
      login_enabled: dto.login_enabled,
      // Si login_enabled = false, NO persistimos credenciales aunque vengan
      // en el DTO. Coherente con la regla de PlacePos y con el CHECK.
      username: dto.login_enabled === true ? (dto.username ?? null) : null,
      password: hashedPassword,
      created_by: createdBy.fullName,
      created_by_id: String(createdBy.id),
      is_archived: false,
    });

    let saved: Employee;
    try {
      saved = await this.repo.save(employee);
    } catch (error) {
      this.translateConstraintError(error);
      throw error;
    }

    // Audit log: solo emitimos el evento si la creación incluye credenciales
    // habilitadas (delegación de acceso al sistema). Defensa en profundidad:
    // sin password ni username en el log — Pino tendría redacción configurada
    // pero el menor superficie de exposición es no escribirlos jamás.
    if (saved.login_enabled === true) {
      this.logger.log({
        event: 'employee.credentials_updated',
        actorId: createdBy.id,
        targetEmployeeId: Number(saved.id),
        companyId,
        action: 'createWithLogin',
      });
    }

    return saved;
  }

  /**
   * Actualiza campos de perfil (name/phone/email/address/role). NO toca
   * credenciales ni archived (esos van en endpoints específicos).
   *
   * Defensa en profundidad: usamos `repo.update({ id, company_id }, dto)` en
   * vez de `findOne + save` para que el filtro multi-tenant esté en el WHERE
   * del UPDATE. Si por algún bug el id de otra company se colara, la query
   * actualizaría 0 filas y el `findOne` posterior tiraría 404.
   *
   * Después del update releemos para devolver el snapshot fresco al cliente
   * (defensa contra triggers o defaults que muten el row).
   */
  async update(id: number, dto: UpdateEmployeeDto, companyId: number): Promise<Employee> {
    // Pre-validar existencia + tenancy. Sin esto, un update con `dto = {}`
    // sobre un id ajeno respondería 200 con datos correctos pero sin haber
    // tocado nada — UX confusa.
    await this.findOne(id, companyId);

    // Construimos el patch solo con campos definidos para no nullificar
    // accidentalmente columnas no enviadas.
    const patch: Partial<Employee> = {};
    if (dto.name !== undefined) {
      patch.name = dto.name;
    }
    if (dto.phone !== undefined) {
      patch.phone = dto.phone ?? null;
    }
    if (dto.email !== undefined) {
      patch.email = dto.email ?? null;
    }
    if (dto.address !== undefined) {
      patch.address = dto.address ?? null;
    }
    if (dto.role !== undefined) {
      patch.role = dto.role;
    }

    if (Object.keys(patch).length === 0) {
      // Body vacío: devolvemos el row tal cual. Mismo comportamiento que
      // PlacePos (el cliente puede mandar PUT con `{}` para refrescar).
      return this.findOne(id, companyId);
    }

    await this.repo.update({ id: String(id), company_id: String(companyId) }, patch);
    return this.findOne(id, companyId);
  }

  /**
   * Actualiza username y/o password.
   *
   *   - Si ambos vienen ausentes → 400.
   *   - `username` colisionado → 409 `USERNAME_TAKEN`.
   *   - `password` se hashea con argon2id (mismas opciones que el AuthService).
   *   - Nunca puede dejar el employee en estado inválido (login_enabled=true
   *     sin credenciales) porque este endpoint solo SETEA credenciales, no
   *     las nullifica.
   *
   * `actorId` es el `user_id` del owner autenticado (extraído del JWT en el
   * controller). Se usa SOLO para el audit log; nunca se persiste aquí.
   */
  async updateCredentials(
    id: number,
    dto: UpdateCredentialsDto,
    companyId: number,
    actorId: number,
  ): Promise<Employee> {
    if (!dto.username && !dto.password) {
      throw new BadRequestException('Al menos uno de username o password debe enviarse');
    }

    // Validar tenancy antes de hashear (no gastar CPU si va a fallar).
    await this.findOne(id, companyId);

    const patch: Partial<Employee> = {};
    if (dto.username !== undefined) {
      patch.username = dto.username;
    }
    if (dto.password !== undefined) {
      patch.password = await argon2.hash(dto.password, ARGON2_OPTIONS);
    }

    try {
      await this.repo.update({ id: String(id), company_id: String(companyId) }, patch);
    } catch (error) {
      this.translateConstraintError(error);
      throw error;
    }

    // Audit log post-éxito. NO incluimos username/password/hash — solo IDs y
    // acción. Si la operación falla a mitad, este log NO se emite (correcto).
    this.logger.log({
      event: 'employee.credentials_updated',
      actorId,
      targetEmployeeId: id,
      companyId,
      action: 'updateCredentials',
    });

    return this.findOne(id, companyId);
  }

  /**
   * Habilita o deshabilita el acceso del employee a `POST /auth/user`.
   *
   *   - `enabled = true` y el employee no tiene credenciales → 422.
   *     El cliente debe primero asignar credenciales por
   *     `PUT /employees/:id/credentials`.
   *
   *   - `enabled = false` se acepta siempre (revocación).
   *
   * El CHECK constraint en DB también protege: si por algún bug el service
   * intentara habilitar login sin credenciales, Postgres rechaza y atrapamos
   * el error por nombre del constraint.
   *
   * `actorId` es el `user_id` del owner autenticado; se usa SOLO para el
   * audit log.
   */
  async toggleLogin(
    id: number,
    enabled: boolean,
    companyId: number,
    actorId: number,
  ): Promise<Employee> {
    const employee = await this.findOne(id, companyId);

    if (enabled === true && (!employee.username || !employee.password)) {
      throw new UnprocessableEntityException(
        'Debe configurar username y password antes de habilitar el login',
      );
    }

    try {
      await this.repo.update(
        { id: String(id), company_id: String(companyId) },
        { login_enabled: enabled },
      );
    } catch (error) {
      this.translateConstraintError(error);
      throw error;
    }

    // Audit log post-éxito. Registra cambio de estado de login del employee.
    this.logger.log({
      event: 'employee.credentials_updated',
      actorId,
      targetEmployeeId: id,
      companyId,
      action: 'toggleLogin',
    });

    return this.findOne(id, companyId);
  }

  /**
   * Traduce errores de Postgres a `HttpException`s con mensaje legible.
   * Llamada desde catches de save/update para no propagar SQL al cliente.
   *
   * NO re-lanza: si no matchea, deja que el caller relance el error
   * original. Esto preserva los `instanceof` downstream.
   */
  private translateConstraintError(error: unknown): void {
    if (!(error instanceof QueryFailedError)) {
      return;
    }

    const pgError = error as QueryFailedError & {
      code?: string;
      constraint?: string;
      detail?: string;
    };

    if (pgError.code === PG_UNIQUE_VIOLATION && pgError.constraint === IDX_USERNAME_UNIQUE) {
      throw new ConflictException({
        message: 'Username ya está en uso',
        payload: { code: 'USERNAME_TAKEN' },
      });
    }

    if (pgError.constraint === CHK_LOGIN_REQUIRES_CREDENTIALS) {
      // Defensa de última línea: el service ya valida esto en pre-flight,
      // pero si por alguna razón llegamos aquí, devolvemos 400 amigable
      // en vez de 500.
      this.logger.warn(
        `CHECK ${CHK_LOGIN_REQUIRES_CREDENTIALS} disparado — escenario inesperado: ${pgError.detail ?? pgError.message}`,
      );
      throw new BadRequestException(
        'No se puede dejar al empleado sin credenciales mientras tenga login habilitado',
      );
    }
  }
}
