import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FileMetadata } from '@google-cloud/storage';

import { dayjs, nowBogota } from '@/common/utils/dayjs';
import type { DatabaseConfig } from '@/config/database.config';
import type { BackupsConfig } from '@/config/backups.config';

import { GcsStorageService } from '../gcs-storage.service';

export interface CreatedBackup {
  name: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  contentType: string | null;
  durationMs: number;
  /** Respaldos antiguos borrados para respetar el tope de retención. */
  prunedCount: number;
}

/** Cuántos bytes de stderr de `pg_dump` se conservan para el mensaje de error. */
const MAX_STDERR = 4000;

/** Firma del formato custom de pg_dump; sirve para validar el archivo subido. */
const PG_DUMP_MAGIC = 'PGDMP';

/**
 * Genera un respaldo de la base de datos con `pg_dump` y lo sube a Google Cloud
 * Storage.
 *
 * El volcado va EN STREAMING (`pg_dump` → GCS): nunca toca el disco del
 * contenedor ni se acumula en memoria, así que el tamaño de la BD no es un
 * límite. Formato `custom` (-Fc), que ya viene comprimido y se restaura con
 * `pg_restore`.
 *
 * Requiere `pg_dump` en la imagen (ver Dockerfile: postgresql-client) con
 * versión >= la del servidor; un cliente más viejo se niega a volcar.
 */
@Injectable()
export class CreateBackupAction {
  private readonly logger = new Logger(CreateBackupAction.name);
  private readonly db: DatabaseConfig;
  private readonly backups: BackupsConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly storage: GcsStorageService,
  ) {
    this.db = this.configService.getOrThrow<DatabaseConfig>('database');
    this.backups = this.configService.getOrThrow<BackupsConfig>('backups');
  }

  /** Binario a ejecutar: el configurado, o `pg_dump` del PATH. */
  private get pgDumpBin(): string {
    return this.backups.pgDumpBin || 'pg_dump';
  }

  /**
   * `backups/placepos-20260727-115405.dump`: fecha y hora de COLOMBIA en 24h
   * (las 13:54:05 son `135405`, no `015405`). El formato es ordenable
   * alfabéticamente, así que el nombre basta para saber cuál es el más viejo.
   */
  private buildObjectName(now: dayjs.Dayjs = nowBogota()): string {
    const stamp = now.format('YYYYMMDD-HHmmss');
    return `${this.backups.prefix}/placepos-${stamp}.dump`;
  }

  async execute(): Promise<CreatedBackup> {
    const startedAt = Date.now();
    const objectName = this.buildObjectName();
    const file = this.storage.getBucket().file(objectName);

    // Se poda ANTES de crear, dejando sitio para el nuevo: así el bucket nunca
    // llega a tener más de `maxBackups` ni por un instante. El precio es que un
    // volcado fallido deja el bucket con uno menos; se prefiere eso a exceder el
    // tope, que es el requisito explícito.
    const pruned = await this.prune(this.backups.maxBackups - 1);

    const child = spawn(
      this.pgDumpBin,
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--host',
        this.db.host,
        '--port',
        String(this.db.port),
        '--username',
        this.db.username,
        '--dbname',
        this.db.database,
      ],
      {
        env: { ...process.env, PGPASSWORD: this.db.password },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) {
        stderr += chunk.toString('utf8');
      }
    });

    // `pg_dump` colgado (red caída, lock eterno) no debe dejar la petición viva.
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, this.backups.timeoutMs);

    // Si el proceso no llega a arrancar (pg_dump ausente) o revienta, hay que
    // ROMPER el stream: si no, la subida se quedaría esperando datos que ya
    // nunca van a llegar y la petición colgaría hasta el timeout.
    child.once('error', (err: Error) => {
      child.stdout.destroy(err);
    });

    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    // Si la subida falla antes, nadie espera esta promesa: se neutraliza para no
    // dejar un rechazo sin manejar.
    exited.catch(() => undefined);

    try {
      await pipeline(
        child.stdout,
        file.createWriteStream({ contentType: 'application/octet-stream', resumable: false }),
      );
      const code = await exited;
      if (code !== 0) {
        throw new Error(stderr.trim() || `pg_dump terminó con código ${code}`);
      }
    } catch (e) {
      child.kill('SIGKILL');
      // Un objeto a medias en el bucket es peor que ninguno: se limpia.
      await this.storage.remove(objectName);
      const message = (e as Error).message;
      this.logger.error(`Respaldo fallido (${objectName}): ${message}`);
      throw new InternalServerErrorException(
        message.includes('ENOENT')
          ? `No se encontró pg_dump (${this.pgDumpBin}). Instálalo en el servidor de la API o ` +
              'define PG_DUMP_BIN con su ruta.'
          : `No se pudo generar el respaldo: ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    // Verificación: que el proceso terminara en 0 no garantiza que el objeto
    // quedara bien en el bucket. Se comprueba que existe, que pesa algo y que
    // empieza por la firma del formato custom de pg_dump.
    const metadata = await this.verify(objectName);

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `Respaldo creado: ${objectName} (${metadata.size ?? '?'} bytes, ${durationMs} ms, ${pruned} podado(s))`,
    );

    return {
      name: objectName,
      fileName: objectName.split('/').pop() ?? objectName,
      sizeBytes: Number(metadata.size ?? 0),
      createdAt: String(metadata.timeCreated ?? new Date().toISOString()),
      contentType: metadata.contentType ?? null,
      durationMs,
      prunedCount: pruned,
    };
  }

  /**
   * Comprueba que el respaldo recién subido es utilizable. Si no lo es, lo borra
   * y falla: un archivo corrupto que aparenta ser un respaldo es peor que la
   * ausencia de respaldo.
   */
  private async verify(objectName: string): Promise<FileMetadata> {
    const file = this.storage.getBucket().file(objectName);

    const [exists] = await file.exists();
    if (!exists) {
      throw new InternalServerErrorException(
        'El respaldo no quedó guardado en el bucket. Revisa las credenciales de Google Storage.',
      );
    }

    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size ?? 0);
    if (size <= 0) {
      await this.storage.remove(objectName);
      throw new InternalServerErrorException('El respaldo quedó vacío; se descartó.');
    }

    // Firma del formato custom de pg_dump: los primeros 5 bytes son "PGDMP".
    try {
      const [head] = await file.download({ start: 0, end: PG_DUMP_MAGIC.length - 1 });
      if (head.toString('utf8') !== PG_DUMP_MAGIC) {
        await this.storage.remove(objectName);
        throw new InternalServerErrorException(
          'El archivo subido no es un respaldo válido de PostgreSQL; se descartó.',
        );
      }
    } catch (e) {
      if (e instanceof InternalServerErrorException) {
        throw e;
      }
      // No poder leer la cabecera no invalida el respaldo (puede ser un permiso
      // de lectura ausente): se avisa y se da por bueno el tamaño.
      this.logger.warn(
        `No se pudo verificar la cabecera de ${objectName}: ${(e as Error).message}`,
      );
    }

    return metadata;
  }

  /**
   * Deja como mucho `keep` respaldos, borrando los más antiguos. Devuelve
   * cuántos borró.
   */
  private async prune(keep: number): Promise<number> {
    if (keep < 0) {
      return 0;
    }
    const existing = await this.storage.list(); // ya viene del más nuevo al más viejo
    const excess = existing.slice(Math.max(0, keep));
    for (const backup of excess) {
      await this.storage.remove(backup.name);
      this.logger.log(`Respaldo podado por retención (${keep} máx.): ${backup.name}`);
    }
    return excess.length;
  }
}
