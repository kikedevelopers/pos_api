import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';

import type {
  JwtPayload,
  UserType as JwtUserType,
  TokenScope,
} from '@/common/types/jwt-payload.type';

import { bigintToNumber } from './bigint-to-number';

/**
 * Input neutral para firmar un JWT desde un `User` o un `Employee`.
 *
 * **Paridad PlacePos — claim `type` para Employees**: cuando el caller
 * representa una entidad de la tabla `employees`, `type` DEBE ser el literal
 * `'employee'`, sin importar si el `role` real es `manager` o `employee`. El
 * cliente local de PlacePos emite siempre `type: 'employee'` para esta tabla;
 * cualquier divergencia rompería la regla #1 del proyecto (paridad byte-por-
 * byte). El rol granular vive en `employees.role` y se consulta por
 * `JWT.user_id` cuando se requiera gatear features.
 */
export interface SignTokenInput {
  userId: string;
  companyId: string | null;
  name: string;
  lastname: string;
  type: JwtUserType;
  account: 'user' | 'employee';
  /**
   * Alcance del token. Omitido = `app` (el de siempre, abre todo el API). El
   * portal de facturación de la landing firma `portal`, que solo vale en las
   * rutas `@PortalRoute()`.
   */
  scope?: TokenScope;
}

/**
 * Encapsula la emisión de JWTs. TTL según el tipo de usuario:
 *
 *   - `owner | superadmin`: `JWT_EXPIRES_OWNER` (default 7d).
 *   - otros (manager, employee): `JWT_EXPIRES_EMPLOYEE` (default 1d).
 */
@Injectable()
export class JwtIssuerService {
  private readonly logger = new Logger(JwtIssuerService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async sign(input: SignTokenInput): Promise<string> {
    // Comparación contra literales string en vez de enum: `input.type` es la
    // unión literal `JwtUserType` (no el enum `UserType`), porque también
    // puede representar a un employee ('manager' | 'employee'). Comparar enum
    // vs unión dispara `no-unsafe-enum-comparison`.
    const isOwnerLike = input.type === 'owner' || input.type === 'superadmin';
    // El token del portal vive MUCHO menos que el de la app: se emite en un
    // navegador (no en el equipo del negocio) y solo sirve para mirar y cambiar
    // el plan. Una sesión de facturación de una semana en un computador
    // compartido no le hace ningún favor a nadie.
    const expiresIn =
      input.scope === 'portal'
        ? (this.configService.get<string>('JWT_EXPIRES_PORTAL') ?? '12h')
        : isOwnerLike
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
      // Solo se escribe cuando acota: un token `app` sale byte a byte igual que
      // antes de que existiera el portal.
      ...(input.scope === 'portal' ? { scope: 'portal' as const } : {}),
    };

    // `expiresIn` viene de env como string libre ('7d', '1d', etc). El tipo
    // estricto `StringValue` de `jsonwebtoken` no acepta `string` plano; lo
    // pasamos por `JwtSignOptions` con cast a `unknown` para satisfacer al
    // compilador sin perder la validación runtime (jsonwebtoken parsea el
    // formato y lanza si es inválido).
    const signOptions: JwtSignOptions = { expiresIn: expiresIn as unknown as number };
    return this.jwtService.signAsync(payload, signOptions);
  }
}
