import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';

import { DummyHashService } from '@/modules/auth/internal/dummy-hash.service';
import { JwtIssuerService } from '@/modules/auth/internal/jwt-issuer.service';
import { userToAuthUserDto } from '@/modules/auth/internal/auth-mappers';
import { UserType } from '@/modules/users/entities/user.entity';
import { UsersService } from '@/modules/users/users.service';

import type { PortalLoginDto, PortalLoginResponseDto } from '../dto/portal-login.dto';

/**
 * Login del portal de facturación (landing).
 *
 * Es el MISMO flujo de credenciales que `POST /auth/user` —mismo hash, mismos
 * mensajes, misma exigencia de cuenta activada— con tres diferencias
 * deliberadas:
 *
 *   1. **No bloquea por suscripción vencida.** Es el punto entero del portal:
 *      quien tiene la suscripción vencida es exactamente quien necesita entrar
 *      a arreglarla. Bloquearlo aquí sería mandarlo a pagar por un canal que
 *      no existe.
 *
 *   2. **Solo dueños.** La suscripción es del dueño de la cuenta. Un empleado
 *      no gestiona el cobro del negocio, y el mensaje se lo dice sin rodeos en
 *      vez de dejarlo pensando que se equivocó de contraseña.
 *
 *   3. **Emite un token acotado** (`scope: 'portal'`), que solo abre `/portal/*`.
 *      Sin eso, dejar entrar con la suscripción vencida sería regalar acceso a
 *      todo el API justo a las cuentas bloqueadas.
 *
 * Anti-enumeración: igual que el login de la app, TODA decisión específica
 * (no es dueño, sin activar) ocurre DESPUÉS de verificar la contraseña, y el
 * camino sin match gasta un `argon2.verify` contra el hash dummy para no
 * delatar por tiempo si el correo existe.
 */
@Injectable()
export class PortalLoginAction {
  private readonly logger = new Logger(PortalLoginAction.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtIssuer: JwtIssuerService,
    private readonly dummyHash: DummyHashService,
  ) {}

  async execute(dto: PortalLoginDto): Promise<PortalLoginResponseDto> {
    const user = await this.usersService.findByEmail(dto.email);

    // Los usuarios espejo de empleados (`type: 'employee'`) tienen correos
    // sintéticos y nunca autentican por email: se tratan como "no existe".
    if (!user || user.type === UserType.EMPLOYEE) {
      await argon2.verify(this.dummyHash.get(), dto.password).catch(() => false);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const passwordValid = await argon2.verify(user.password, dto.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Cuenta sin activar, primero: no tiene sentido hablarle de su plan a quien
    // todavía no ha confirmado que el correo es suyo. Mismo código y mismo
    // texto que el login de la app — el usuario no debería notar dos idiomas.
    if (!user.activated_at) {
      throw new ForbiddenException({
        message:
          'Tu cuenta todavía no está activada. Abre el correo de bienvenida y pulsa "Activar mi cuenta".',
        payload: { code: 'ACCOUNT_NOT_ACTIVATED' },
      });
    }

    // Solo dueños. El superadmin también queda fuera: no tiene company ni
    // suscripción que gestionar, y su sitio es el panel interno.
    if (user.type !== UserType.OWNER || user.company_id === null) {
      throw new ForbiddenException({
        message:
          'Solo el dueño de la cuenta puede gestionar la suscripción. Si trabajas en el negocio, entra desde la aplicación.',
        payload: { code: 'PORTAL_OWNER_ONLY' },
      });
    }

    const access_token = await this.jwtIssuer.sign({
      userId: user.id,
      companyId: user.company_id,
      name: user.name,
      lastname: user.lastname,
      type: user.type,
      account: 'user',
      scope: 'portal',
    });

    // A propósito NO se toca `users.last_login`: esa columna significa "la
    // última vez que este negocio usó el POS" y la lee el panel de soporte.
    // Contar una visita a la pantalla de facturación como uso del sistema
    // haría ver activo a un cliente que solo entró a mirar su plan.
    this.logger.log({
      event: 'portal.login',
      userId: Number(user.id),
      companyId: Number(user.company_id),
    });

    return {
      access_token,
      user: userToAuthUserDto(user, this.logger),
    };
  }
}
