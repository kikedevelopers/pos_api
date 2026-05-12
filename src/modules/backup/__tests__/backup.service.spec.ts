import { ServiceUnavailableException } from '@nestjs/common';

import { BackupService } from '../backup.service';

/**
 * Tests del stub `BackupService`. Verifican que:
 *   - Siempre lanza `ServiceUnavailableException` (status 503).
 *   - El mensaje y el `payload.code` son estables — el frontend de PlacePos
 *     en modo cloud puede branchear por el code, así que cualquier cambio
 *     accidental aquí rompería la integración.
 *   - El método `throwUnavailable` jamás retorna (tipo `never`).
 */
describe('BackupService', () => {
  let service: BackupService;

  beforeEach(() => {
    service = new BackupService();
  });

  it('throwUnavailable lanza ServiceUnavailableException con código estable', () => {
    expect(() => service.throwUnavailable('GET /backup', { userId: 1, companyId: 42 })).toThrow(
      ServiceUnavailableException,
    );
  });

  it('lleva el mensaje y el code BACKUP_NOT_AVAILABLE_IN_CLOUD', () => {
    try {
      service.throwUnavailable('POST /backup', { userId: 7, companyId: 99 });
      fail('debió haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      const exception = err as ServiceUnavailableException;
      const body = exception.getResponse() as {
        message: string;
        payload: { code: string };
      };
      expect(body.message).toBe(
        'Backup local no está disponible en modo cloud. Contacta soporte si necesitas exportar tus datos.',
      );
      expect(body.payload.code).toBe('BACKUP_NOT_AVAILABLE_IN_CLOUD');
    }
  });

  it('soporta companyId null (caso superadmin)', () => {
    expect(() =>
      service.throwUnavailable('GET /backup/1/download', { userId: 1, companyId: null }),
    ).toThrow(ServiceUnavailableException);
  });
});
