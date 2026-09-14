import { Test, type TestingModule } from '@nestjs/testing';

import { PurgeExpiredProductImagesAction } from '../actions/purge-expired-product-images.action';
import { ProductImageStorageService } from '../product-image-storage.service';
import { PURGE_IMAGES_CRON, ProductImagesScheduler } from '../product-images.scheduler';

/**
 * El cron solo decide CUÁNDO. Lo que no puede hacer nunca es tumbar el proceso
 * ni quedarse bloqueado tras un fallo.
 */

async function buildHarness(options: { isConfigured?: boolean; fails?: boolean } = {}) {
  const execute = jest.fn(() =>
    options.fails
      ? Promise.reject(new Error('bucket inaccesible'))
      : Promise.resolve({ purged: 3, failed: 0 }),
  );

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ProductImagesScheduler,
      {
        provide: ProductImageStorageService,
        useValue: { isConfigured: options.isConfigured ?? true },
      },
      { provide: PurgeExpiredProductImagesAction, useValue: { execute } },
    ],
  }).compile();

  return { scheduler: module.get(ProductImagesScheduler), execute };
}

describe('ProductImagesScheduler', () => {
  it('corre a las 03:00 (lejos de la medianoche del respaldo de la BD)', () => {
    expect(PURGE_IMAGES_CRON).toBe('0 3 * * *');
  });

  it('el cron diario dispara la purga', async () => {
    const h = await buildHarness();

    await h.scheduler.handleDailyPurge();

    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('sin bucket configurado no hace nada', async () => {
    const h = await buildHarness({ isConfigured: false });

    await h.scheduler.handleDailyPurge();

    expect(h.execute).not.toHaveBeenCalled();
  });

  it('un fallo de la purga NO se propaga (el proceso sigue vivo)', async () => {
    const h = await buildHarness({ fails: true });

    await expect(h.scheduler.handleDailyPurge()).resolves.toBeUndefined();
  });

  it('tras un fallo el scheduler queda libre para la corrida siguiente', async () => {
    const h = await buildHarness({ fails: true });

    await h.scheduler.handleDailyPurge();
    await h.scheduler.handleDailyPurge();

    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it('no lanza dos purgas en paralelo si la anterior sigue en curso', async () => {
    // `release` se asigna dentro del ejecutor de la Promise; se declara con
    // tipo explícito para que TS no lo estreche a `never`.
    const pending: { release: () => void } = { release: () => undefined };
    const execute = jest.fn(
      () =>
        new Promise<{ purged: number; failed: number }>((resolve) => {
          pending.release = () => resolve({ purged: 0, failed: 0 });
        }),
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductImagesScheduler,
        { provide: ProductImageStorageService, useValue: { isConfigured: true } },
        { provide: PurgeExpiredProductImagesAction, useValue: { execute } },
      ],
    }).compile();
    const scheduler = module.get(ProductImagesScheduler);

    const first = scheduler.handleDailyPurge();
    await scheduler.handleDailyPurge(); // la segunda se omite

    expect(execute).toHaveBeenCalledTimes(1);

    pending.release();
    await first;
  });
});
