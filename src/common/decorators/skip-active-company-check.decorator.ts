import { SetMetadata } from '@nestjs/common';

export const SKIP_ACTIVE_COMPANY_CHECK_KEY = 'skipActiveCompanyCheck';

/**
 * Exime un handler/controller del `ActiveCompanyGuard`. Se aplica a endpoints
 * de RECUPERACIÓN/gestión que deben funcionar aunque el JWT apunte a una
 * sucursal suspendida: el perfil (`/auth/*`) para leer el estado y el módulo
 * de sucursales (`/branches/*`) para hacer switch al principal o reconciliar.
 * Sin esto, un owner atrapado en una sucursal suspendida no podría salir.
 */
export const SkipActiveCompanyCheck = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_ACTIVE_COMPANY_CHECK_KEY, true);
