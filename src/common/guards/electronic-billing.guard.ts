import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Request } from 'express';

import { assertElectronicBillingEnabled } from '@/common/electronic-billing/electronic-billing.util';
import type { AuthUser } from '@/common/types/jwt-payload.type';

/**
 * Guard para endpoints EXCLUSIVOS de Facturación Electrónica (ej. el catálogo de
 * tarifas de IVA). Verifica contra la BD —no contra el JWT ni el estado del
 * front— que el negocio tenga la FE activa AHORA; si no, corta con 403 y el
 * código `ELECTRONIC_BILLING_DISABLED`.
 *
 * Motivo: el front es una SPA que lee el flag al iniciar sesión. Si el superadmin
 * desactiva la FE mientras el usuario está conectado, su sesión sigue creyendo
 * que es facturador. El backend manda: cualquier operación de FE se revalida aquí
 * y se rechaza si ya está apagada, sin esperar a que el usuario recargue.
 *
 * Debe registrarse DESPUÉS de `JwtAuthGuard` (necesita `request.user`).
 */
@Injectable()
export class ElectronicBillingGuard implements CanActivate {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (!user || user.company_id === null || user.company_id === undefined) {
      throw new ForbiddenException('Usuario sin negocio asociado para Facturación Electrónica.');
    }

    await assertElectronicBillingEnabled(this.dataSource, user.company_id);
    return true;
  }
}
