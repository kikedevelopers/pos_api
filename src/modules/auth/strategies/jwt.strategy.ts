import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type { AccountKind, AuthUser, JwtPayload, UserType } from '@/common/types/jwt-payload.type';

/**
 * Valores permitidos para los enums del payload. Repetidos aquí como literales
 * para validación runtime — el `type` TypeScript no se persiste en el JWT.
 */
const VALID_USER_TYPES: readonly UserType[] = ['superadmin', 'owner', 'manager', 'employee'];
const VALID_ACCOUNTS: readonly AccountKind[] = ['user', 'employee'];

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Estrategia Passport-JWT.
 *
 * Pipeline:
 *   1. Extrae el token del header `Authorization: Bearer <jwt>`.
 *   2. Verifica firma y `exp` contra `JWT_SECRET`. Si falla → 401 desde el guard.
 *   3. `validate(payload)` recibe el payload ya decodificado, valida SU FORMA
 *      y lo retorna como `AuthUser`. NestJS lo cuelga en `request.user`.
 *
 * Por qué validar la forma:
 *   La firma JWT garantiza INTEGRIDAD del payload (nadie lo manipuló), no su
 *   FORMA (que tenga los campos esperados con los tipos esperados). Si por un
 *   bug o cambio futuro firmamos un token con `company_id` ausente o `type`
 *   inválido, sin esta validación los chequeos downstream usarían `undefined`
 *   y podrían pasar guards multi-tenant. Validar aquí fuerza el contrato.
 *
 * NO consulta DB. Si en el futuro se requiere revocación / blacklist, este es
 * el punto donde añadir el lookup.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthUser {
    // `user_id` debe ser un entero positivo.
    if (!isPositiveInt(payload.user_id)) {
      throw new UnauthorizedException('Token con payload inválido');
    }

    // `company_id` puede ser `null` SOLO para superadmin. En cualquier otro
    // caso debe ser un entero positivo. Aceptamos null aquí y dejamos que el
    // chequeo cruzado con `type` ocurra abajo.
    if (payload.company_id !== null && !isPositiveInt(payload.company_id)) {
      throw new UnauthorizedException('Token con payload inválido');
    }

    // `type` debe ser uno de los roles conocidos.
    if (typeof payload.type !== 'string' || !VALID_USER_TYPES.includes(payload.type)) {
      throw new UnauthorizedException('Token con payload inválido');
    }

    // `account` debe ser 'user' o 'employee'.
    if (typeof payload.account !== 'string' || !VALID_ACCOUNTS.includes(payload.account)) {
      throw new UnauthorizedException('Token con payload inválido');
    }

    // `company_id = null` solo es legítimo para superadmin. Cualquier otro
    // null indica payload corrupto: rechazar antes de que el decorador
    // `@CurrentCompany()` o un guard multi-tenant lo procese.
    if (payload.company_id === null && payload.type !== 'superadmin') {
      throw new UnauthorizedException('Token con payload inválido');
    }

    // `name` y `lastname` son strings; no son críticos para seguridad pero
    // validamos tipo básico para no propagar undefined a respuestas.
    if (typeof payload.name !== 'string' || typeof payload.lastname !== 'string') {
      throw new UnauthorizedException('Token con payload inválido');
    }

    return {
      user_id: payload.user_id,
      company_id: payload.company_id,
      name: payload.name,
      lastname: payload.lastname,
      type: payload.type,
      account: payload.account,
    };
  }
}
