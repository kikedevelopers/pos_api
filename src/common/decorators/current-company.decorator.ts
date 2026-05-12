import { createParamDecorator, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthUser } from '@/common/types/jwt-payload.type';

/**
 * Inyecta el `company_id` del usuario autenticado como `number`.
 *
 * Política de seguridad:
 *   - Si no hay `user` en la request (endpoint público mal configurado),
 *     lanza `ForbiddenException`.
 *
 *   - Si `company_id` NO es un entero positivo (null, undefined, NaN, 0,
 *     negativo, float, string, etc.), lanza `ForbiddenException`. Usamos
 *     chequeo POSITIVO de tipo en vez de `=== null` para blindar frente a
 *     payloads corruptos que pasen `0`, `undefined` o tipos inesperados —
 *     cualquiera de esos como filtro de query produciría `WHERE company_id = 0`
 *     que devolvería 0 filas pero no es semánticamente correcto y podría
 *     enmascarar bugs cross-tenant. Mejor fallar rápido.
 *
 *     El caso `null` cubre legítimamente al superadmin; el decorador lo
 *     rechaza porque endpoints de tenant NO deberían exponerse al superadmin
 *     vía este decorator. Si el superadmin necesita un endpoint cross-tenant,
 *     debe usar `/admin/*` y NO este decorator.
 *
 * Uso:
 *   @Get(':id')
 *   findOne(@Param('id', ParseIntPipe) id: number, @CurrentCompany() companyId: number) { ... }
 */
export const CurrentCompany = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Endpoint requiere autenticación');
    }

    if (
      typeof user.company_id !== 'number' ||
      !Number.isInteger(user.company_id) ||
      user.company_id <= 0
    ) {
      throw new ForbiddenException('Endpoint no disponible para superadmin');
    }

    return user.company_id;
  },
);
