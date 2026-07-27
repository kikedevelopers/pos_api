import appConfig, { type AppConfig } from './app.config';
import backupsConfig, { type BackupsConfig } from './backups.config';
import databaseConfig, { type DatabaseConfig } from './database.config';

/**
 * Configuración unificada — agrupa todos los namespaces.
 * Permite registrar todos los configs en `ConfigModule.forRoot({ load: [...] })`.
 */
export const configurationLoaders = [appConfig, databaseConfig, backupsConfig];

export type AppConfiguration = {
  app: AppConfig;
  database: DatabaseConfig;
  backups: BackupsConfig;
};

export { appConfig, databaseConfig, backupsConfig };
export type { AppConfig, DatabaseConfig, BackupsConfig };
