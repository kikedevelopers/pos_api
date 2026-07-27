import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { InternalServerErrorException } from '@nestjs/common';

/** (binario, argumentos, opciones) con los que se invocó `spawn`. */
type SpawnCall = [string, string[], { env: Record<string, string> }];

/** Opciones con las que el action abre el stream de subida a GCS. */
type WriteStreamOptions = {
  metadata?: { metadata?: Record<string, string> };
  resumable?: boolean;
  contentType?: string;
};

const spawnMock = jest.fn();
jest.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args) as unknown,
}));

import { dayjs, APP_TIMEZONE } from '@/common/utils/dayjs';

import { CreateBackupAction } from '../actions/create-backup.action';

/**
 * Cede el control para que `execute()` avance hasta enganchar el proceso hijo:
 * la poda por retención mete un `await` antes del spawn, así que cerrar el
 * proceso demasiado pronto dejaría al action escuchando un evento ya emitido.
 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Proceso hijo falso: stdout/stderr reales para poder hacer pipe de verdad. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** Simula el final de `pg_dump`: cierra stdout y emite el código de salida. */
  finish(code: number, stderrText = ''): void {
    if (stderrText) {
      this.stderr.write(stderrText);
    }
    this.stdout.end();
    setImmediate(() => this.emit('close', code));
  }
}

const DB = {
  host: 'db',
  port: 5432,
  username: 'pos_user',
  password: 's3cret',
  database: 'pos_db',
};
const BACKUPS = {
  bucket: 'my-bucket',
  prefix: 'backups',
  timeoutMs: 600000,
  maxBackups: 7,
  nodeEnv: 'development',
};

/** Respaldos ya existentes en el bucket, del más nuevo al más viejo. */
const existing = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    name: `backups/dev-placepos-2026072${7 - i}-120000.dump`,
    fileName: `dev-placepos-2026072${7 - i}-120000.dump`,
    sizeBytes: 100,
    createdAt: `2026-07-2${7 - i}T12:00:00.000Z`,
    contentType: 'application/octet-stream',
  }));

function buildAction(
  options: {
    uploadFails?: boolean;
    existingCount?: number;
    head?: string;
    size?: string;
    pgDumpBin?: string;
    nodeEnv?: string;
  } = {},
) {
  const written: Buffer[] = [];
  const removed: string[] = [];

  const writeStream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (options.uploadFails) {
        cb(new Error('GCS caído'));
        return;
      }
      written.push(chunk);
      cb();
    },
  });

  const file = {
    createWriteStream: jest.fn<Writable, [WriteStreamOptions]>(() => writeStream),
    getMetadata: jest.fn(() =>
      Promise.resolve([
        {
          size: options.size ?? '2048',
          timeCreated: '2026-07-27T12:00:00.000Z',
          contentType: 'application/octet-stream',
        },
      ]),
    ),
    exists: jest.fn(() => Promise.resolve([true])),
    download: jest.fn(() => Promise.resolve([Buffer.from(options.head ?? 'PGDMP')])),
  };

  const storage = {
    getBucket: () => ({ file: jest.fn(() => file) }),
    list: jest.fn(() => Promise.resolve(existing(options.existingCount ?? 0))),
    remove: jest.fn((name: string) => {
      removed.push(name);
      return Promise.resolve();
    }),
  };

  const configService = {
    getOrThrow: (key: string) =>
      key === 'database'
        ? DB
        : {
            ...BACKUPS,
            pgDumpBin: options.pgDumpBin ?? '',
            nodeEnv: options.nodeEnv ?? 'development',
          },
  };

  // `SHOW server_version` para los metadatos.
  const dataSource = {
    query: jest.fn(() => Promise.resolve([{ server_version: '18.1 (Debian 18.1-1.pgdg13+2)' }])),
  };

  const action = new CreateBackupAction(
    configService as never,
    storage as never,
    dataSource as never,
  );
  return { action, file, storage, written, removed, dataSource };
}

/** Invoca el nombrado privado con un instante concreto (en UTC). */
function buildName(action: CreateBackupAction, isoUtc: string): string {
  const withPrivate = action as unknown as {
    buildObjectName: (now: dayjs.Dayjs) => string;
  };
  return withPrivate.buildObjectName(dayjs(isoUtc).tz(APP_TIMEZONE));
}

describe('CreateBackupAction', () => {
  let child: FakeChild;

  beforeEach(() => {
    spawnMock.mockReset();
    child = new FakeChild();
    // El action lanza dos procesos: uno para `--version` (metadatos) y el del
    // volcado. El primero responde solo; el segundo lo controla cada test.
    spawnMock.mockImplementation((_bin: string, args: string[]): FakeChild => {
      if (args.includes('--version')) {
        const probe = new FakeChild();
        setImmediate(() => {
          probe.stdout.write('pg_dump (PostgreSQL) 18.4\n');
          probe.finish(0);
        });
        return probe;
      }
      return child;
    });
  });

  /** Argumentos del spawn del VOLCADO (ignora la sonda de `--version`). */
  const dumpCall = (): SpawnCall => {
    const calls = spawnMock.mock.calls as unknown as SpawnCall[];
    const call = calls.find((c) => !c[1].includes('--version'));
    if (!call) {
      throw new Error('no se lanzó el volcado');
    }
    return call;
  };

  it('sube el volcado y devuelve los datos del respaldo', async () => {
    const { action, written } = buildAction();

    const promise = action.execute();
    await tick();
    child.stdout.write(Buffer.from('PGDMP-datos'));
    child.finish(0);
    const result = await promise;

    expect(Buffer.concat(written).toString()).toBe('PGDMP-datos');
    expect(result.sizeBytes).toBe(2048);
    expect(result.createdAt).toBe('2026-07-27T12:00:00.000Z');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('nombra el respaldo placepos-YYYYMMDD-HHMMSS.dump', async () => {
    const { action } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(0);
    const result = await promise;

    expect(result.fileName).toMatch(/^dev-placepos-\d{8}-\d{6}\.dump$/);
    expect(result.name).toBe(`backups/${result.fileName}`);
  });

  it('usa la fecha y hora de Bogotá, en formato 24h', () => {
    const { action } = buildAction();
    // 18:54:05 UTC = 13:54:05 en Bogotá (UTC-5) → "135405", no "015405".
    const name = buildName(action, '2026-07-27T18:54:05.000Z');

    expect(name).toBe('backups/dev-placepos-20260727-135405.dump');
  });

  it('la noche de Bogotá sigue siendo el día anterior aunque en UTC ya cambió', () => {
    const { action } = buildAction();
    // 04:30 UTC del 28 = 23:30 del 27 en Bogotá.
    const name = buildName(action, '2026-07-28T04:30:00.000Z');

    expect(name).toBe('backups/dev-placepos-20260727-233000.dump');
  });

  it('rellena con ceros las horas de un dígito', () => {
    const { action } = buildAction();
    // 13:05:07 UTC = 08:05:07 en Bogotá.
    const name = buildName(action, '2026-01-05T13:05:07.000Z');

    expect(name).toBe('backups/dev-placepos-20260105-080507.dump');
  });

  it('invoca pg_dump en formato custom contra la BD configurada', async () => {
    const { action } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(0);
    await promise;

    const [command, args, opts] = dumpCall();
    expect(command).toBe('pg_dump');
    expect(args).toEqual(expect.arrayContaining(['--format=custom', '--dbname', 'pos_db']));
    expect(args).toEqual(expect.arrayContaining(['--host', 'db', '--username', 'pos_user']));
    // La contraseña viaja por entorno, nunca como argumento visible en `ps`.
    expect(opts.env.PGPASSWORD).toBe('s3cret');
    expect(args.join(' ')).not.toContain('s3cret');
  });

  it('sube sin buffering intermedio (streaming, resumable off)', async () => {
    const { action, file } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(0);
    await promise;

    expect(file.createWriteStream).toHaveBeenCalledWith(
      expect.objectContaining({ resumable: false }),
    );
  });

  it('si pg_dump falla, propaga su error y borra el objeto a medias', async () => {
    const { action, storage, removed } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(1, 'FATAL: no existe la base de datos');
    await expect(promise).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(removed[0]).toMatch(/^backups\/dev-placepos-/);
  });

  it('incluye el mensaje real de pg_dump en el error', async () => {
    const { action } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(1, 'FATAL: autenticación password falló');
    await expect(promise).rejects.toThrow(/autenticación password falló/);
  });

  it('en producción el nombre empieza por prod-', async () => {
    const { action } = buildAction({ nodeEnv: 'production' });

    const promise = action.execute();
    await tick();
    child.finish(0);
    const result = await promise;

    expect(result.fileName).toMatch(/^prod-placepos-/);
    expect(result.environment).toBe('prod');
  });

  it('en staging el nombre empieza por staging-', async () => {
    const { action } = buildAction({ nodeEnv: 'staging' });

    const promise = action.execute();
    await tick();
    child.finish(0);
    const result = await promise;

    expect(result.fileName).toMatch(/^staging-placepos-/);
  });

  it('guarda el autor en los metadatos del objeto', async () => {
    const { action, file } = buildAction();

    const promise = action.execute({ createdBy: 'Kike Dev', trigger: 'manual' });
    await tick();
    child.finish(0);
    const result = await promise;

    const options = file.createWriteStream.mock.calls[0][0];
    expect(options.metadata?.metadata).toMatchObject({
      createdBy: 'Kike Dev',
      trigger: 'manual',
      environment: 'dev',
    });
    expect(result.createdBy).toBe('Kike Dev');
  });

  it('sin autor el respaldo queda como Automático (cron)', async () => {
    const { action, file } = buildAction();

    const promise = action.execute({ trigger: 'cron' });
    await tick();
    child.finish(0);
    const result = await promise;

    const options = file.createWriteStream.mock.calls[0][0];
    expect(options.metadata?.metadata).toMatchObject({
      createdBy: 'Automático',
      trigger: 'cron',
      environment: 'dev',
    });
    expect(result.createdBy).toBe('Automático');
  });

  it('un autor en blanco cuenta como automático', async () => {
    const { action } = buildAction();

    const promise = action.execute({ createdBy: '   ' });
    await tick();
    child.finish(0);
    const result = await promise;

    expect(result.createdBy).toBe('Automático');
  });

  it('guarda en los metadatos la versión del servidor y la de pg_dump', async () => {
    const { action, file, dataSource } = buildAction();

    const promise = action.execute({ createdBy: 'Kike Dev' });
    await tick();
    child.finish(0);
    const result = await promise;

    expect(dataSource.query).toHaveBeenCalledWith('SHOW server_version');
    const options = file.createWriteStream.mock.calls[0][0];
    expect(options.metadata?.metadata).toMatchObject({
      serverVersion: '18.1',
      pgDumpVersion: '18.4',
    });
    expect(result.serverVersion).toBe('18.1');
    expect(result.pgDumpVersion).toBe('18.4');
  });

  it('si no se puede leer la versión del servidor, el respaldo igual se hace', async () => {
    const { action, dataSource } = buildAction();
    dataSource.query.mockRejectedValueOnce(new Error('sin conexión'));

    const promise = action.execute();
    await tick();
    child.finish(0);
    const result = await promise;

    expect(result.serverVersion).toBeNull();
    expect(result.sizeBytes).toBe(2048);
  });

  it('usa el binario de PG_DUMP_BIN cuando está configurado', async () => {
    const { action } = buildAction({ pgDumpBin: '/opt/homebrew/opt/libpq/bin/pg_dump' });

    const promise = action.execute();
    await tick();
    child.finish(0);
    await promise;

    const [command] = dumpCall();
    expect(command).toBe('/opt/homebrew/opt/libpq/bin/pg_dump');
  });

  it('sin PG_DUMP_BIN cae al pg_dump del PATH', async () => {
    const { action } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(0);
    await promise;

    const [command] = dumpCall();
    expect(command).toBe('pg_dump');
  });

  it('avisa claramente cuando pg_dump no está instalado', async () => {
    const { action } = buildAction();

    const promise = action.execute();
    await tick();
    setImmediate(() => child.emit('error', new Error('spawn pg_dump ENOENT')));
    await expect(promise).rejects.toThrow(/No se encontró pg_dump/);
  });

  it('si falla la subida, mata el proceso y limpia', async () => {
    const { action, storage } = buildAction({ uploadFails: true });

    const promise = action.execute();
    await tick();
    child.stdout.write(Buffer.from('datos'));
    await expect(promise).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(child.killed).toBe(true);
    expect(storage.remove).toHaveBeenCalled();
  });

  it('con 7 respaldos ya existentes borra el más viejo antes de crear', async () => {
    const { action, storage, removed } = buildAction({ existingCount: 7 });

    const promise = action.execute();
    await tick();
    child.finish(0);
    const result = await promise;

    // Se poda hasta dejar 6, para que con el nuevo queden exactamente 7.
    expect(removed).toEqual(['backups/dev-placepos-20260721-120000.dump']);
    expect(result.prunedCount).toBe(1);
    expect(storage.list).toHaveBeenCalled();
  });

  it('con menos de 7 no borra nada', async () => {
    const { action, removed } = buildAction({ existingCount: 3 });

    const promise = action.execute();
    await tick();
    child.finish(0);
    const result = await promise;

    expect(removed).toEqual([]);
    expect(result.prunedCount).toBe(0);
  });

  it('si el bucket tiene de más (10), los recorta todos de una vez', async () => {
    const { action, removed } = buildAction({ existingCount: 10 });

    const promise = action.execute();
    await tick();
    child.finish(0);
    const result = await promise;

    // Deja 6 + el nuevo = 7.
    expect(removed).toHaveLength(4);
    expect(result.prunedCount).toBe(4);
  });

  it('poda ANTES de volcar, para no superar el tope ni un instante', async () => {
    const { action, storage } = buildAction({ existingCount: 7 });

    const promise = action.execute();
    await tick();
    child.finish(0);
    await promise;

    const listOrder = (storage.list as jest.Mock).mock.invocationCallOrder[0];
    const calls = spawnMock.mock.calls as unknown as SpawnCall[];
    const dumpIndex = calls.findIndex((c) => !c[1].includes('--version'));
    expect(listOrder).toBeLessThan(spawnMock.mock.invocationCallOrder[dumpIndex]);
  });

  it('verifica que el objeto quedó en el bucket', async () => {
    const { action, file } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(0);
    await promise;

    expect(file.exists).toHaveBeenCalled();
  });

  it('rechaza y borra un respaldo vacío', async () => {
    const { action, removed } = buildAction({ size: '0' });

    const promise = action.execute();
    await tick();
    child.finish(0);
    await expect(promise).rejects.toThrow(/vacío/);
    expect(removed).toHaveLength(1);
  });

  it('rechaza y borra un archivo que no es un dump de PostgreSQL', async () => {
    const { action, removed } = buildAction({ head: 'XXXXX' });

    const promise = action.execute();
    await tick();
    child.finish(0);
    await expect(promise).rejects.toThrow(/no es un respaldo válido/);
    expect(removed).toHaveLength(1);
  });

  it('no deja el objeto en el bucket cuando algo sale mal', async () => {
    const { action, removed } = buildAction();

    const promise = action.execute();
    await tick();
    child.finish(2, 'error de red');
    await expect(promise).rejects.toThrow();

    expect(removed).toHaveLength(1);
  });
});
