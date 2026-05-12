import appConfig, { type AppConfig } from './app.config';
import databaseConfig, { type DatabaseConfig } from './database.config';

/**
 * Configuración unificada — agrupa todos los namespaces.
 * Permite registrar todos los configs en `ConfigModule.forRoot({ load: [...] })`.
 */
export const configurationLoaders = [appConfig, databaseConfig];

export type AppConfiguration = {
  app: AppConfig;
  database: DatabaseConfig;
};

export { appConfig, databaseConfig };
export type { AppConfig, DatabaseConfig };
