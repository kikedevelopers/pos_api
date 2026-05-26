import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';

import { EmployeesService } from '@/modules/employees/employees.service';
import { ensureMirrorUserForEmployee } from '@/modules/employees/internal/ensure-mirror-user-for-employee.helper';
import { SubscriptionExpiredException } from '@/modules/subscriptions/subscription-expired.exception';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';
import { UsersService } from '@/modules/users/users.service';

import type { AuthResponseDto } from '../dto/auth-response.dto';
import type { LoginDto } from '../dto/login.dto';
import { employeeToAuthUserDto, userToAuthUserDto } from '../internal/auth-mappers';
import { DummyHashService } from '../internal/dummy-hash.service';
import { JwtIssuerService } from '../internal/jwt-issuer.service';
import { looksLikeEmail } from '../internal/looks-like-email';

/**
 * Login dual User/Employee. Devuelve el mismo shape que `register`.
 *
 * Pipeline:
 *
 *   1. Si `dto.username` parece email (contiene `@`) → buscar primero en
 *      `users` por email; si match, autenticar como User.
 *
 *   2. Si no es email, o no se encontró User → buscar en `employees` por
 *      `username` (lookup GLOBAL, ver `FindEmployeeByUsernameAction`). El
 *      método ya filtra `is_archived = false` y `login_enabled = true`.
 *
 *   3. Si ninguno matcha → tiempo constante con `argon2.verify(dummyHash)` y
 *      luego `UnauthorizedException`. Anti-enumeración: el atacante no puede
 *      distinguir por timing si el username/email existe.
 *
 *   4. Si matcha User: JWT con `type: user.type` (`owner` | `superadmin`),
 *      `account: 'user'`, `company_id: user.company_id`. TTL según tipo.
 *
 *   5. Si matcha Employee:
 *        a. Si `Employee.user_id` es null, se crea el User espejo on-the-fly
 *           dentro de una transacción (`ensureMirrorUserForEmployee`). Esto
 *           garantiza que TODO JWT de un Employee con login viable lleve
 *           `user_id = users.id` (no `employees.id`), porque los modelos
 *           atados a `users.id` (cash_register, cash_register_log,
 *           financial_movement.created_by_id) lo requieren.
 *        b. JWT con `type: 'employee'` LITERAL (paridad byte-por-byte con
 *           el contrato PlacePos local), `account: 'employee'`, `company_id:
 *           employee.company_id`, `user_id: User_espejo.id`. TTL = 1 día.
 *           El rol granular (`manager` | `employee`) queda persistido en
 *           `employees.role`; cuando se necesite gatear features por rol,
 *           se consulta la tabla por `JWT.user_id`, NO por claim del JWT.
 *
 * Política de error UNIFORME: TODOS los caminos fallidos devuelven el mismo
 * `UnauthorizedException("Credenciales inválidas")`. Nunca se distingue entre
 * "no existe" / "password mal" / "archivado" / "login deshabilitado". Esto es
 * clave para evitar enumeración cross-tenant.
 *
 * Anti-timing: los hashes de users y employees usan el mismo `ARGON2_OPTIONS`,
 * así que el costo de `argon2.verify` es idéntico. El `dummyHash` también. La
 * única ventana detectable es el round-trip extra a `employees` cuando el
 * username NO trae `@` — aceptable: el orden de lookup (`users` o `employees`
 * primero) lo decide la presencia de `@`, no la existencia del registro, por
 * lo que un atacante no infiere existencia por orden.
 *
 * Transacción: SOLO se abre cuando matchea Employee Y hace falta crear el
 * User espejo (camino mutativo). El path User es read-only.
 */
@Injectable()
export class LoginAction {
  private readonly logger = new Logger(LoginAction.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly employeesService: EmployeesService,
    private readonly jwtIssuer: JwtIssuerService,
    private readonly dummyHash: DummyHashService,
    private readonly subscriptionsService: SubscriptionsService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Bloqueo de login por suscripción vencida.
   *
   * Se invoca DESPUÉS de `argon2.verify` exitoso (no antes) para preservar la
   * política anti-enumeración: el chequeo no filtra existencia de cuentas
   * porque solo se alcanza con credenciales válidas.
   *
   * Superadmin (`company_id` null) está exento — su login nunca se bloquea.
   * Si la suscripción no existe o `expires_at < now`, lanza 402.
   */
  private async assertSubscriptionActive(companyId: number | null): Promise<void> {
    if (companyId === null) {
      return;
    }
    const subscription = await this.subscriptionsService.findByCompany(companyId);
    if (!subscription) {
      throw new SubscriptionExpiredException(null);
    }
    if (subscription.expires_at.getTime() < Date.now()) {
      throw new SubscriptionExpiredException(subscription.expires_at);
    }
  }

  async execute(dto: LoginDto): Promise<AuthResponseDto> {
    const isEmailShape = looksLikeEmail(dto.username);

    // Lookup primario según la forma del input. Si NO luce como email, ni
    // siquiera tocamos `users` — los users autentican por email. Esto reduce
    // el espacio de ataque: un atacante que envía `kike` no puede enumerar
    // emails de users.
    //
    // EDGE-CASE multi-tenant: los User espejo de Employee tienen emails
    // sintéticos `${username}.${companyId}@local.placepos`. Aunque el espejo
    // viva en `users`, el cliente PlacePos NUNCA envía estos emails como
    // credencial. Filtramos defensivamente en `findByEmail` para que un
    // atacante no pueda autenticarse contra un espejo via email.
    const user = isEmailShape ? await this.usersService.findByEmail(dto.username) : null;

    // Filtro defensivo: si el User encontrado es un espejo (type='employee'),
    // NO permitimos login por este path — los espejos solo autentican vía el
    // path Employee con username. Esto preserva el invariante "JWT.account
    // refleja la entidad real con la que se autenticó".
    const isMirrorUser = user?.type === 'employee';

    if (user && !isMirrorUser) {
      const passwordValid = await argon2.verify(user.password, dto.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Credenciales inválidas');
      }
      // Bloqueo por suscripción vencida — tras verify, antes de firmar. El
      // superadmin (company_id null) queda exento dentro del helper.
      await this.assertSubscriptionActive(
        user.company_id === null ? null : Number(user.company_id),
      );
      const access_token = await this.jwtIssuer.sign({
        userId: user.id,
        companyId: user.company_id,
        name: user.name,
        lastname: user.lastname,
        type: user.type,
        account: 'user',
      });
      return {
        access_token,
        user: userToAuthUserDto(user, this.logger),
      };
    }

    // Fallback a employees. Aplica tanto si el username NO luce email como si
    // luce email pero no matchea en `users` (edge case raro pero posible —
    // defensa en profundidad) o si matchea pero es un espejo (filtrado arriba).
    const employee = await this.employeesService.findByUsername(dto.username);

    if (employee && employee.password) {
      const passwordValid = await argon2.verify(employee.password, dto.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Credenciales inválidas');
      }

      // Bloqueo por suscripción vencida — tras verify, antes de crear/sincronizar
      // el User espejo y firmar. Los employees siempre pertenecen a una company.
      await this.assertSubscriptionActive(Number(employee.company_id));

      // Garantizar el User espejo. Si ya existe, sincroniza; si no, lo crea.
      // Transacción dedicada — corta — para que el INSERT del User + UPDATE
      // del employee.user_id sean atómicos. El JWT se firma DESPUÉS del
      // commit, con el id final.
      const mirrorUser = await this.dataSource.transaction((manager) =>
        ensureMirrorUserForEmployee({
          manager,
          employee,
          companyId: Number(employee.company_id),
        }),
      );

      const access_token = await this.jwtIssuer.sign({
        userId: mirrorUser.id,
        companyId: employee.company_id,
        name: employee.name,
        lastname: '', // Employees no tienen lastname en el contrato PlacePos.
        // Paridad PlacePos: el JWT siempre emite `type: 'employee'` literal
        // para entidades de la tabla `employees`, sin importar si su `role`
        // real es `manager` o `employee`. El rol granular vive en DB y se
        // consulta por `JWT.user_id` cuando se requiera.
        type: 'employee',
        account: 'employee',
      });

      this.logger.log({
        event: 'auth.employee_login',
        employeeId: Number(employee.id),
        mirrorUserId: Number(mirrorUser.id),
        companyId: Number(employee.company_id),
      });

      return {
        access_token,
        user: employeeToAuthUserDto(employee, this.logger),
      };
    }

    // No match en ninguna entidad. Gastamos el ciclo de CPU del verify contra
    // el dummyHash para que el atacante no pueda distinguir por timing
    // "username no existe" de "username existe pero password mal".
    await argon2.verify(this.dummyHash.get(), dto.password).catch(() => false);

    // Si llegamos aquí con un `user` que era espejo (rechazado arriba), gastamos
    // un verify adicional contra su hash real para que el atacante no detecte
    // por timing que "el email existe pero corresponde a un espejo".
    if (isMirrorUser && user) {
      await argon2.verify(user.password, dto.password).catch(() => false);
    }

    throw new UnauthorizedException('Credenciales inválidas');
  }
}
