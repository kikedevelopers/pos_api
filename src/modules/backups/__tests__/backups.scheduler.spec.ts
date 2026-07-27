import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { APP_TIMEZONE } from '@/common/utils/dayjs';

import { BackupsScheduler, DAILY_BACKUP_CRON } from '../backups.scheduler';
import { CreateBackupAction } from '../actions/create-backup.action';
import { GcsStorageService } from '../gcs-storage.service';

const RESULT = {
  name: 'backups/placepos-20260728-000000.dump',
  fileName: 'placepos-20260728-000000.dump',
  sizeBytes: 1024,
  createdAt: '2026-07-28T05:00:00.000Z',
  contentType: 'application/octet-stream',
  durationMs: 1200,
  prunedCount: 1,
};

function buildScheduler(
  options: { cronEnabled?: boolean; isConfigured?: boolean; fail?: string } = {},
) {
  const execute = jest.fn(() =>
    options.fail ? Promise.reject(new Error(options.fail)) : Promise.resolve(RESULT),
  );
  const createBackupAction = { execute } as unknown as CreateBackupAction;
  const storage = { isConfigured: options.isConfigured ?? true } as GcsStorageService;
  const configService = {
    getOrThrow: () => ({ cronEnabled: options.cronEnabled ?? true }),
  } as unknown as ConfigService;

  return { scheduler: new BackupsScheduler(configService, storage, createBackupAction), execute };
}

describe('BackupsScheduler', () => {
  it('genera el respaldo cuando se dispara', async () => {
    const { scheduler, execute } = buildScheduler();

    await scheduler.handleDailyBackup();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('no hace nada si el cron está apagado', async () => {
    const { scheduler, execute } = buildScheduler({ cronEnabled: false });

    await scheduler.handleDailyBackup();

    expect(execute).not.toHaveBeenCalled();
  });

  it('no hace nada si falta el bucket', async () => {
    const { scheduler, execute } = buildScheduler({ isConfigured: false });

    await scheduler.handleDailyBackup();

    expect(execute).not.toHaveBeenCalled();
  });

  it('un fallo del respaldo no propaga la excepción', async () => {
    const { scheduler, execute } = buildScheduler({ fail: 'pg_dump reventó' });

    await expect(scheduler.handleDailyBackup()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('tras un fallo el siguiente disparo vuelve a intentarlo', async () => {
    const { scheduler, execute } = buildScheduler({ fail: 'error transitorio' });

    await scheduler.handleDailyBackup();
    await scheduler.handleDailyBackup();

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('no solapa dos ejecuciones', async () => {
    let release: () => void = () => undefined;
    const execute = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(RESULT);
        }),
    );
    const scheduler = new BackupsScheduler(
      { getOrThrow: () => ({ cronEnabled: true }) } as unknown as ConfigService,
      { isConfigured: true } as GcsStorageService,
      { execute } as unknown as CreateBackupAction,
    );

    const first = scheduler.handleDailyBackup();
    await scheduler.handleDailyBackup(); // llega mientras el primero sigue vivo
    expect(execute).toHaveBeenCalledTimes(1);

    release();
    await first;

    // Terminado el primero, el siguiente disparo sí procede. (`release` apunta
    // ya a esta segunda ejecución; hay que liberarla para no dejarla colgada.)
    const second = scheduler.handleDailyBackup();
    expect(execute).toHaveBeenCalledTimes(2);
    release();
    await second;
  });
});

describe('BackupsScheduler · registro del cron', () => {
  it('queda programado a medianoche en hora de Colombia', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        BackupsScheduler,
        { provide: ConfigService, useValue: { getOrThrow: () => ({ cronEnabled: true }) } },
        { provide: GcsStorageService, useValue: { isConfigured: true } },
        { provide: CreateBackupAction, useValue: { execute: jest.fn() } },
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get(SchedulerRegistry);
    const job = registry.getCronJob('daily-backup');

    expect(DAILY_BACKUP_CRON).toBe('0 0 * * *');
    expect(job).toBeDefined();
    // La próxima ejecución debe caer a las 00:00 de Bogotá.
    const next = job.nextDate().setZone(APP_TIMEZONE);
    expect(next.hour).toBe(0);
    expect(next.minute).toBe(0);

    await moduleRef.close();
  });
});
