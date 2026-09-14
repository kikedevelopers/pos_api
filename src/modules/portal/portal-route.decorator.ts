import type { CustomDecorator } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';

export const PORTAL_ROUTE_KEY = 'portalRoute';

/**
 * Marca una ruta como parte del PORTAL de facturación (la landing).
 *
 * Es la única superficie donde un token con `scope: 'portal'` es aceptado. Todo
 * lo demás del API lo rechaza con 403 (`PortalScopeGuard`), porque el login del
 * portal deja entrar con la suscripción vencida y sin esta frontera vencer
 * sería la manera de saltarse el bloqueo.
 */
export const PortalRoute = (): CustomDecorator<string> => SetMetadata(PORTAL_ROUTE_KEY, true);
