import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';

import { EmployeesService } from '@/modules/employees/employees.service';
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
 *   5. Si matcha Employee: JWT con `type: 'employee'` LITERAL (paridad
 *      byte-por-byte con el contrato PlacePos local), `account: 'employee'`,
 *      `company_id: employee.company_id`. TTL = 1 día (los employees nunca
 *      obtienen 7 días). El rol real (`manager` | `employee`) queda
 *      persistido en `employees.role`; cuando se necesite gatear features
 *      por rol, se consulta la tabla por `JWT.user_id`, NO por claim del
 *      JWT. Esto preserva el contrato y mantiene `RolesGuard` simple.
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
 * Read-only path — no requiere transacción (no escribe en DB).
 */
@Injectable()
export class LoginAction {
  private readonly logger = new Logger(LoginAction.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly employeesService: EmployeesService,
    private readonly jwtIssuer: JwtIssuerService,
    private readonly dummyHash: DummyHashService,
  ) {}

  async execute(dto: LoginDto): Promise<AuthResponseDto> {
    const isEmailShape = looksLikeEmail(dto.username);

    // Lookup primario según la forma del input. Si NO luce como email, ni
    // siquiera tocamos `users` — los users autentican por email. Esto reduce
    // el espacio de ataque: un atacante que envía `kike` no puede enumerar
    // emails de users.
    const user = isEmailShape ? await this.usersService.findByEmail(dto.username) : null;

    if (user) {
      const passwordValid = await argon2.verify(user.password, dto.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Credenciales inválidas');
      }
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
    // defensa en profundidad).
    const employee = await this.employeesService.findByUsername(dto.username);

    if (employee && employee.password) {
      const passwordValid = await argon2.verify(employee.password, dto.password);
      if (!passwordValid) {
        throw new UnauthorizedException('Credenciales inválidas');
      }
      const access_token = await this.jwtIssuer.sign({
        userId: employee.id,
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
      return {
        access_token,
        user: employeeToAuthUserDto(employee, this.logger),
      };
    }

    // No match en ninguna entidad. Gastamos el ciclo de CPU del verify contra
    // el dummyHash para que el atacante no pueda distinguir por timing
    // "username no existe" de "username existe pero password mal".
    await argon2.verify(this.dummyHash.get(), dto.password).catch(() => false);
    throw new UnauthorizedException('Credenciales inválidas');
  }
}
