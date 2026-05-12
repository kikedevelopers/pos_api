import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Servicio stub para `/backup/*`.
 *
 * En modo CLOUD el backup es operativo del proveedor (snapshots de la DB
 * managed, almacenamiento offsite). NO se expone export/import local de
 * datos al cliente final — eso solo aplica al PlacePos local con SQLite/PG
 * empacados en el Electron.
 *
 * Conservamos las rutas para mantener el contrato HTTP idéntico al servidor
 * local de PlacePos: el cliente Electron al cambiar a modo CLOUD no debe
 * romper si invoca estas rutas. Devolvemos 503 + código estable
 * `BACKUP_NOT_AVAILABLE_IN_CLOUD` para que el frontend pueda detectar el
 * modo y degradar la UI (ocultar botón, mostrar tooltip, etc.).
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  /**
   * Único método público. Centraliza el throw y el log de telemetría para
   * detectar clientes que aún no migraron al flujo cloud (deberían dejar de
   * invocar `/backup/*`). El controller pasa el endpoint y el actor para
   * facilitar el debugging y la observabilidad cross-tenant.
   */
  throwUnavailable(endpoint: string, actor: { userId: number; companyId: number | null }): never {
    this.logger.warn({
      event: 'backup.attempted_in_cloud',
      endpoint,
      user_id: actor.userId,
      company_id: actor.companyId,
    });

    throw new ServiceUnavailableException({
      message:
        'Backup local no está disponible en modo cloud. Contacta soporte si necesitas exportar tus datos.',
      payload: { code: 'BACKUP_NOT_AVAILABLE_IN_CLOUD' },
    });
  }
}
