import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { DataSource, QueryFailedError, type Repository } from 'typeorm';

import type {
  AuthUser,
  JwtPayload,
  UserType as JwtUserType,
} from '@/common/types/jwt-payload.type';
import { Company } from '@/modules/companies/entities/company.entity';
import type { Employee } from '@/modules/employees/entities/employee.entity';
import { EmployeesService } from '@/modules/employees/employees.service';
import { User, UserType } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import { ARGON2_OPTIONS } from '@/common/utils/argon2-options';

import type {
  AuthResponseDto,
  AuthUserDto,
  CompanyProfileDto,
  ProfileResponseDto,
} from './dto/auth-response.dto';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

/**
 * Convierte un id `bigint` (string en TypeORM) a `number`. El contrato
 * PlacePos espera ids numéricos. Si el id excede `Number.MAX_SAFE_INTEGER`
 * loguea un warning; en práctica no rompe hasta tener ~9e15 filas.
 */
function bigintToNumber(id: string, logger: Logger, what: string): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) {
    logger.warn(
      `${what} id excede Number.MAX_SAFE_INTEGER (${id}); puede perder precisión en JSON`,
    );
  }
  return n;
}

/**
 * Postgres SQLSTATE para `unique_violation`. Lo detectamos en el catch del
 * register para traducir la race condition email-tomado a 409 con `code`.
 */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Heurística para decidir si el `username` recibido en el login luce como
 * email. Si trae un `@`, primero buscamos en `users`; si no, en `employees`.
 *
 * No es un EmailValidator estricto a propósito: si un user tiene email con
 * forma rara (que el `@IsEmail` del register hubiera rechazado) ya no
 * existe en DB; y si un employee se llama `kike@ares.dev` (también raro pero
 * permitido por DB), igual lo buscaríamos como user → no encontraríamos →
 * el caller hace fallback. El peor caso es un round-trip extra a DB, NO una
 * autenticación cruzada.
 */
function looksLikeEmail(value: string): boolean {
  return value.includes('@');
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Hash dummy precomputado al arrancar. Cuando el login no encuentra al user,
   * hacemos un `argon2.verify` contra este hash para que el tiempo de
   * respuesta sea estadísticamente indistinguible del caso "user existe pero
   * password mal". Evita enumeración de emails por timing side-channel.
   */
  private dummyHash!: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly employeesService: EmployeesService,
    @InjectRepository(Company)
    private readonly companiesRepo: Repository<Company>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Una sola vez al arrancar. ~30-60ms en CPU moderna; aceptable.
    this.dummyHash = await argon2.hash('dummy-password-for-timing-constant-login', ARGON2_OPTIONS);
  }

  /**
   * Registra un nuevo `owner` + `company` atómicamente. Devuelve el JWT y
   * el snapshot del usuario, igual que el flujo de login.
   *
   * Errores:
   *   - 409 `EMAIL_TAKEN` si el email ya pertenece a otro user.
   *     Dos vías de detección:
   *       1. Fast-path: `findOne(email)` previo al INSERT (ahorra hashing).
   *       2. Hard-path: catch `QueryFailedError` con `code = 23505` cuando
   *          dos POST concurrentes pasan ambos por el fast-path antes del
   *          primer INSERT (race condition).
   */
  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    return this.dataSource.transaction<AuthResponseDto>(async (manager) => {
      // 1. Fast-path: verificar que el email no esté tomado antes de hashear.
      const existing = await manager.findOne(User, { where: { email: dto.user.email } });
      if (existing) {
        throw new ConflictException({
          message: 'Ya existe una cuenta con ese email',
          payload: { code: 'EMAIL_TAKEN' },
        });
      }

      // 2. Crear company.
      const company = manager.create(Company, {
        name: dto.company.name,
        document_number: dto.company.document_number ?? null,
        address: dto.company.address ?? null,
        email: dto.company.email ?? null,
        phone_number: dto.company.phone_number ?? null,
      });
      const savedCompany = await manager.save(Company, company);

      // 3. Hashear password y crear user owner.
      const passwordHash = await argon2.hash(dto.user.password, ARGON2_OPTIONS);
      const user = manager.create(User, {
        name: dto.user.name,
        lastname: dto.user.lastname,
        email: dto.user.email,
        password: passwordHash,
        type: UserType.OWNER,
        company_id: savedCompany.id,
      });

      let savedUser: User;
      try {
        savedUser = await manager.save(User, user);
      } catch (error) {
        // Hard-path: race condition. Otro POST concurrente insertó el mismo
        // email entre nuestro fast-path y este INSERT. `dataSource.transaction`
        // propagará el throw y hará rollback automático de la company creada.
        if (error instanceof QueryFailedError) {
          const code = (error as QueryFailedError & { code?: string }).code;
          if (code === PG_UNIQUE_VIOLATION) {
            throw new ConflictException({
              message: 'Ya existe una cuenta con ese email',
              payload: { code: 'EMAIL_TAKEN' },
            });
          }
        }
        throw error;
      }

      // 4. TODO(Fase 5/10): crear seeds esenciales — TicketSetting (por cada
      //    TicketType), Wallet "Efectivo" con balance 0 y AppSetting defaults
      //    (app_color_mode='white', pos_margins_enabled='false'). Por ahora
      //    estas entidades no existen; cuando se creen, este bloque se
      //    rellena con manager.save(TicketSetting, [...]) etc., dentro de la
      //    misma transacción para garantizar atomicidad.

      const access_token = await this.signToken({
        userId: savedUser.id,
        companyId: savedUser.company_id,
        name: savedUser.name,
        lastname: savedUser.lastname,
        type: savedUser.type,
        account: 'user',
      });
      return {
        access_token,
        user: this.toAuthUserDto(savedUser),
      };
    });
  }

  /**
   * Login dual User/Employee. Devuelve el mismo shape que `register`.
   *
   * Pipeline:
   *
   *   1. Si `dto.username` parece email (contiene `@`) → buscar primero en
   *      `users` por email; si match, autenticar como User.
   *
   *   2. Si no es email, o no se encontró User → buscar en `employees` por
   *      `username` (lookup GLOBAL, ver `EmployeesService.findByUsername`).
   *      El método ya filtra `is_archived = false` y `login_enabled = true`.
   *
   *   3. Si ninguno matcha → tiempo constante con `argon2.verify(dummyHash)`
   *      y luego `UnauthorizedException`. Anti-enumeración: el atacante no
   *      puede distinguir por timing si el username/email existe.
   *
   *   4. Si matcha User: JWT con `type: user.type` (`owner` | `superadmin`),
   *      `account: 'user'`, `company_id: user.company_id`. TTL según tipo.
   *
   *   5. Si matcha Employee: JWT con `type: 'employee'` LITERAL (paridad
   *      byte-por-byte con el contrato PlacePos local), `account: 'employee'`,
   *      `company_id: employee.company_id`. TTL = 1 día (los employees nunca
   *      obtienen 7 días). El rol real (`manager` | `employee`) queda
   *      persistido en `employees.role`; cuando se necesite gatear features
   *      por rol, se consulta la tabla por `JWT.user_id`, NO por claim del
   *      JWT. Esto preserva el contrato y mantiene `RolesGuard` simple.
   *
   * Política de error UNIFORME: TODOS los caminos fallidos devuelven el
   * mismo `UnauthorizedException("Credenciales inválidas")`. Nunca se
   * distingue entre "no existe" / "password mal" / "archivado" / "login
   * deshabilitado". Esto es clave para evitar enumeración cross-tenant
   * (un atacante no puede saber qué usernames pertenecen a qué company).
   *
   * Anti-timing: los hashes de users y employees usan el mismo
   * `ARGON2_OPTIONS`, así que el costo de `argon2.verify` es idéntico. El
   * `dummyHash` también. La única ventana detectable es el round-trip extra
   * a `employees` cuando el username NO trae `@` — aceptable: el orden de
   * lookup (`users` o `employees` primero) lo decide la presencia de `@`,
   * no la existencia del registro, por lo que un atacante no infiere
   * existencia por orden.
   */
  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const isEmailShape = looksLikeEmail(dto.username);

    // Lookup primario según la forma del input. Importante: si NO luce como
    // email, ni siquiera tocamos `users` — los users autentican por email.
    // Esto reduce el espacio de ataque: un atacante que envía `kike` no
    // puede enumerar emails de users.
    const user = isEmailShape ? await this.usersService.findByEmail(dto.username) : null;

    if (user) {
      const passwordValid = await argon2.verify(user.password, dto.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Credenciales inválidas');
      }
      const access_token = await this.signToken({
        userId: user.id,
        companyId: user.company_id,
        name: user.name,
        lastname: user.lastname,
        type: user.type,
        account: 'user',
      });
      return {
        access_token,
        user: this.toAuthUserDto(user),
      };
    }

    // Fallback a employees. Aplica tanto si el username NO luce email como
    // si luce email pero no matchea en `users` (edge case raro pero posible
    // — defensa en profundidad).
    const employee = await this.employeesService.findByUsername(dto.username);

    if (employee && employee.password) {
      const passwordValid = await argon2.verify(employee.password, dto.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Credenciales inválidas');
      }
      const access_token = await this.signToken({
        userId: employee.id,
        companyId: employee.company_id,
        name: employee.name,
        lastname: '', // Employees no tienen lastname en el contrato PlacePos.
        // CRIT (paridad PlacePos): el JWT siempre emite `type: 'employee'`
        // literal para entidades de la tabla `employees`, sin importar si su
        // `role` real es `manager` o `employee`. El rol granular vive en DB
        // y se consulta por `JWT.user_id` cuando se requiera. Ver JSDoc del
        // método `signToken` y el espejo en PlacePos `auth.routes.ts`.
        type: 'employee',
        account: 'employee',
      });
      return {
        access_token,
        user: this.toAuthUserDtoFromEmployee(employee),
      };
    }

    // No match en ninguna entidad. Gastamos el ciclo de CPU del verify
    // contra el dummyHash para que el atacante no pueda distinguir por
    // timing "username no existe" de "username existe pero password mal".
    await argon2.verify(this.dummyHash, dto.password).catch(() => false);
    throw new UnauthorizedException('Credenciales inválidas');
  }

  /**
   * `GET /auth/me`. Para `owner`/`manager`/`employee` busca el user actual
   * en DB y retorna el snapshot. Para `superadmin` retorna lo que viene en
   * el JWT (no hay company que validar).
   */
  async getMe(authUser: AuthUser): Promise<AuthUserDto> {
    if (authUser.type === 'superadmin' || authUser.company_id === null) {
      return {
        id: authUser.user_id,
        name: authUser.name,
        lastname: authUser.lastname,
        email: null,
        type: authUser.type,
      };
    }

    const user = await this.usersService.findByIdInCompany(authUser.user_id, authUser.company_id);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return this.toAuthUserDto(user);
  }

  /**
   * `GET /auth/profile`. Devuelve user + company.
   */
  async getProfile(authUser: AuthUser): Promise<ProfileResponseDto> {
    if (authUser.type === 'superadmin' || authUser.company_id === null) {
      // Superadmin no tiene company asociada; devolvemos null como `company`.
      return {
        user: await this.getMe(authUser),
        company: null,
      };
    }

    const user = await this.usersService.findByIdInCompany(authUser.user_id, authUser.company_id);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const company = await this.companiesRepo.findOne({
      where: { id: String(authUser.company_id) },
    });
    if (!company) {
      // Inconsistencia de datos: el JWT apunta a una company eliminada.
      throw new NotFoundException('Empresa no encontrada');
    }

    return {
      user: this.toAuthUserDto(user),
      company: this.toCompanyProfileDto(company),
    };
  }

  /**
   * Firma un JWT con TTL según el tipo de usuario:
   *
   *   - `owner | superadmin`: `JWT_EXPIRES_OWNER` (default 7d).
   *   - otros (manager, employee): `JWT_EXPIRES_EMPLOYEE` (default 1d).
   *
   * Acepta un shape neutral con los campos mínimos. Permite firmar el token
   * tanto desde un `User` como desde un `Employee` sin acoplar el método a
   * una entidad concreta (Dependency Inversion).
   *
   * **Paridad PlacePos — claim `type` para Employees**: cuando el caller
   * representa una entidad de la tabla `employees`, `input.type` DEBE ser
   * el literal `'employee'`, sin importar si el `role` real es `manager` o
   * `employee`. El cliente local de PlacePos emite siempre `type: 'employee'`
   * para esta tabla; cualquier divergencia rompería la regla #1 del proyecto
   * (paridad byte-por-byte). El rol granular vive en `employees.role` y se
   * consulta por `JWT.user_id` cuando se requiera gatear features.
   */
  private async signToken(input: {
    userId: string;
    companyId: string | null;
    name: string;
    lastname: string;
    type: JwtUserType;
    account: 'user' | 'employee';
  }): Promise<string> {
    // Comparación contra literales string en vez de enum: `input.type` es la
    // unión literal `JwtUserType` (no el enum `UserType`), porque también puede
    // representar a un employee ('manager' | 'employee'). Comparar enum vs
    // unión dispara `no-unsafe-enum-comparison`.
    const isOwnerLike = input.type === 'owner' || input.type === 'superadmin';
    const expiresIn = isOwnerLike
      ? (this.configService.get<string>('JWT_EXPIRES_OWNER') ?? '7d')
      : (this.configService.get<string>('JWT_EXPIRES_EMPLOYEE') ?? '1d');

    const payload: JwtPayload = {
      user_id: bigintToNumber(
        input.userId,
        this.logger,
        input.account === 'user' ? 'User' : 'Employee',
      ),
      company_id:
        input.companyId !== null ? bigintToNumber(input.companyId, this.logger, 'Company') : null,
      name: input.name,
      lastname: input.lastname,
      type: input.type,
      account: input.account,
    };

    // `expiresIn` viene de env como string libre ('7d', '1d', etc). El tipo
    // estricto `StringValue` de `jsonwebtoken` no acepta `string` plano; lo
    // pasamos por `JwtSignOptions` con cast a `unknown` para satisfacer al
    // compilador sin perder la validación runtime (jsonwebtoken parsea el
    // formato y lanza si es inválido).
    const signOptions: JwtSignOptions = { expiresIn: expiresIn as unknown as number };
    return this.jwtService.signAsync(payload, signOptions);
  }

  private toAuthUserDto(user: User): AuthUserDto {
    return {
      id: bigintToNumber(user.id, this.logger, 'User'),
      name: user.name,
      lastname: user.lastname,
      email: user.email,
      type: user.type,
    };
  }

  /**
   * Proyección de `Employee` al `AuthUserDto` del contrato PlacePos.
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
   *     porque es compartido con el path User; aquí garantizamos que el
   *     valor concreto sea siempre `string`. Coerción documentada.
   *
   *   - `type`: paridad PlacePos. SIEMPRE `'employee'` literal (CRIT-1 de
   *     la auditoría). El rol real (`manager` | `employee`) vive en
   *     `employees.role` y se consulta por `JWT.user_id` cuando aplique.
   *     No se distingue en el JWT ni en `payload.user`.
   */
  private toAuthUserDtoFromEmployee(employee: Employee): AuthUserDto {
    return {
      id: bigintToNumber(employee.id, this.logger, 'Employee'),
      name: employee.name,
      lastname: '',
      email: employee.email ?? employee.username ?? '',
      // Paridad PlacePos: literal, no `employee.role`.
      type: 'employee',
    };
  }

  private toCompanyProfileDto(company: Company): CompanyProfileDto {
    return {
      id: bigintToNumber(company.id, this.logger, 'Company'),
      name: company.name,
      document_number: company.document_number,
      address: company.address,
      email: company.email,
      phone_number: company.phone_number,
      break_even_amount: company.break_even_amount,
      break_even_period_days: company.break_even_period_days,
    };
  }
}
