import aiConfig, { type AiConfig } from './ai.config';
import appConfig, { type AppConfig } from './app.config';
import backupsConfig, { type BackupsConfig } from './backups.config';
import databaseConfig, { type DatabaseConfig } from './database.config';
import feConfig, { type FeConfig } from './fe.config';
import mailConfig, { type MailConfig } from './mail.config';
import productImagesConfig, { type ProductImagesConfig } from './product-images.config';

/**
 * Configuración unificada — agrupa todos los namespaces.
 * Permite registrar todos los configs en `ConfigModule.forRoot({ load: [...] })`.
 */
export const configurationLoaders = [
  appConfig,
  databaseConfig,
  backupsConfig,
  productImagesConfig,
  aiConfig,
  mailConfig,
  feConfig,
];

export type AppConfiguration = {
  app: AppConfig;
  database: DatabaseConfig;
  backups: BackupsConfig;
  productImages: ProductImagesConfig;
  ai: AiConfig;
  mail: MailConfig;
  fe: FeConfig;
};

export {
  appConfig,
  databaseConfig,
  backupsConfig,
  productImagesConfig,
  aiConfig,
  mailConfig,
  feConfig,
};
export type {
  AppConfig,
  DatabaseConfig,
  BackupsConfig,
  ProductImagesConfig,
  AiConfig,
  MailConfig,
  FeConfig,
};
