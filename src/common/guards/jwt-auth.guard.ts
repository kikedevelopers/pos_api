import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';

import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';

/**
 * Guard global de autenticación JWT.
 *
 * Comportamiento:
 *   - Si el handler o el controller están marcados con `@Public()`, deja
 *     pasar sin verificar token. `request.user` quedará `undefined`.
 *   - En caso contrario, delega en `AuthGuard('jwt')` de Passport, que llama
 *     a `JwtStrategy.validate(payload)` y cuelga el resultado en
 *     `request.user`.
 *
 * `handleRequest` se sobrescribe para devolver `UnauthorizedException` con
 * mensajes en español, coincidentes con los del contrato PlacePos.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Cast a `boolean | Promise<boolean>` — `AuthGuard.canActivate` declara
    // también `Observable<boolean>` pero en práctica devuelve promise.
    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  override handleRequest<TUser>(err: unknown, user: TUser, info: unknown): TUser {
    if (err || !user) {
      // Distingue token ausente vs inválido para alinear con el contrato.
      const infoName = (info as { name?: string } | null)?.name;
      if (infoName === 'TokenExpiredError' || infoName === 'JsonWebTokenError') {
        throw new UnauthorizedException('Token inválido o expirado');
      }
      throw new UnauthorizedException('Token no proporcionado');
    }
    return user;
  }
}
