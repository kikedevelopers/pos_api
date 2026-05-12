import { Injectable } from '@nestjs/common';

export interface AppInfo {
  name: string;
  version: string;
  environment: string;
  uptime: number;
}

@Injectable()
export class AppService {
  /**
   * Devuelve información básica de la API.
   * Útil para verificar despliegue y versión.
   */
  getInfo(): AppInfo {
    return {
      name: 'POS API',
      version: process.env.npm_package_version ?? '0.1.0',
      environment: process.env.NODE_ENV ?? 'development',
      uptime: process.uptime(),
    };
  }
}
