import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { join } from 'node:path';

// Carga las variables del `.env` para el CLI de TypeORM (fuera del contexto de Nest).
loadEnv();

/**
 * DataSource utilizado EXCLUSIVAMENTE por el CLI de TypeORM (migraciones).
 * En runtime, Nest usa el `TypeOrmModule.forRootAsync` con la misma configuración.
 *
 * NOTA: Los paths apuntan a archivos compilados o transpilados con ts-node.
 * El glob soporta ambos casos (ts y js) para que funcione en dev y prod.
 */
export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'pos_db',
  synchronize: false,
  logging: process.env.DB_LOGGING === 'true',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  migrationsTableName: 'migrations',
  migrationsRun: false,
};

const dataSource = new DataSource(dataSourceOptions);
export default dataSource;
