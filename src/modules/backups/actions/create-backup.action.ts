import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
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
  /** Quién lo generó (nombre del admin, o "Automático" si fue el cron). */
  createdBy: string;
  /** Entorno donde se generó: `prod` / `dev` / `staging`. */
  environment: string;
  /** Versión del servidor del que se volcó (ej. `18.1`). */
  serverVersion: string | null;
  /** Versión de la herramienta que lo generó (ej. `18.4`). */
  pgDumpVersion: string | null;
}

/** Quién pide el respaldo. Sin autor conocido se registra como automático. */
export interface BackupActor {
  /** Nombre del admin que pulsó el botón; vacío = automático. */
  createdBy?: string;
  /** `manual` (panel) o `cron` (respaldo programado). */
  trigger?: 'manual' | 'cron';
}

/** Etiqueta de autoría cuando nadie firma el respaldo (cron, o body sin autor). */
export const AUTOMATIC_AUTHOR = 'Automático';

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

  /** `pg_dump --version` no cambia mientras viva el proceso: se cachea. */
  private pgDumpVersionCache: string | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly storage: GcsStorageService,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {
    this.db = this.configService.getOrThrow<DatabaseConfig>('database');
    this.backups = this.configService.getOrThrow<BackupsConfig>('backups');
  }

  /**
   * Etiqueta corta del entorno para el nombre del archivo. Distingue de un
   * vistazo un respaldo de producción de uno hecho desde una máquina de
   * desarrollo, que conviven en el mismo bucket.
   */
  private get environmentTag(): string {
    if (this.backups.nodeEnv === 'production') {
      return 'prod';
    }
    if (this.backups.nodeEnv === 'staging') {
      return 'staging';
    }
    return 'dev';
  }

  /** Binario a ejecutar: el configurado, o `pg_dump` del PATH. */
  private get pgDumpBin(): string {
    return this.backups.pgDumpBin || 'pg_dump';
  }

  /**
   * `backups/prod-placepos-20260727-115405.dump`: entorno + fecha y hora de
   * COLOMBIA en 24h (las 13:54:05 son `135405`, no `015405`). El formato es
   * ordenable alfabéticamente dentro de cada entorno, así que el nombre basta
   * para saber cuál es el más viejo.
   */
  private buildObjectName(now: dayjs.Dayjs = nowBogota()): string {
    const stamp = now.format('YYYYMMDD-HHmmss');
    return `${this.backups.prefix}/${this.environmentTag}-placepos-${stamp}.dump`;
  }

  /**
   * Versión del servidor del que se vuelca. Se guarda en los metadatos porque
   * restaurar exige herramientas de versión >= la del origen: sin este dato hay
   * que adivinarlo el día que haga falta recuperar.
   */
  private async getServerVersion(): Promise<string | null> {
    try {
      const rows = await this.dataSource.query<{ server_version: string }[]>('SHOW server_version');
      // Postgres devuelve cosas como "18.1 (Debian 18.1-1.pgdg13+2)".
      return rows[0]?.server_version?.split(' ')[0] ?? null;
    } catch (e) {
      this.logger.warn(`No se pudo leer la versión del servidor: ${(e as Error).message}`);
      return null;
    }
  }

  /** Versión del `pg_dump` que genera el archivo. */
  private async getPgDumpVersion(): Promise<string | null> {
    if (this.pgDumpVersionCache) {
      return this.pgDumpVersionCache;
    }
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const probe = spawn(this.pgDumpBin, ['--version']);
        let out = '';
        probe.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
        probe.once('error', reject);
        probe.once('close', () => resolve(out));
      });
      // "pg_dump (PostgreSQL) 18.4" → "18.4"
      const version = /(\d+(?:\.\d+)*)\s*$/.exec(output.trim())?.[1] ?? null;
      this.pgDumpVersionCache = version;
      return version;
    } catch {
      return null;
    }
  }

  async execute(actor: BackupActor = {}): Promise<CreatedBackup> {
    const startedAt = Date.now();
    const createdBy = actor.createdBy?.trim() || AUTOMATIC_AUTHOR;
    const trigger = actor.trigger ?? (actor.createdBy?.trim() ? 'manual' : 'cron');
    const [serverVersion, pgDumpVersion] = await Promise.all([
      this.getServerVersion(),
      this.getPgDumpVersion(),
    ]);
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
        file.createWriteStream({
          contentType: 'application/octet-stream',
          resumable: false,
          // Autoría en los METADATOS del objeto: evita una tabla y un flujo de
          // BD solo para saber quién generó cada respaldo.
          metadata: {
            metadata: {
              createdBy,
              trigger,
              environment: this.environmentTag,
              // Para restaurar sin sorpresas: pg_restore debe ser >= serverVersion.
              ...(serverVersion ? { serverVersion } : {}),
              ...(pgDumpVersion ? { pgDumpVersion } : {}),
            },
          },
        }),
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
      createdBy,
      environment: this.environmentTag,
      serverVersion,
      pgDumpVersion,
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
