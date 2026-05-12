import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
  type HealthCheckResult,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '@/common/decorators/public.decorator';

/**
 * Endpoints de salud:
 * - `/health/live`  → liveness (no toca DB, ideal para Kubernetes livenessProbe).
 * - `/health/ready` → readiness (toca DB, indica si la app puede servir tráfico).
 * - `/health`       → check completo (DB + memoria).
 *
 * Todos marcados `@Public()` para que el guard global JWT no los bloquee.
 */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Health check completo (DB + memoria)' })
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.db.pingCheck('database', { timeout: 1500 }),
      (): Promise<HealthIndicatorResult> => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
      (): Promise<HealthIndicatorResult> => this.memory.checkRSS('memory_rss', 500 * 1024 * 1024),
    ]);
  }

  @Get('live')
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness probe — la aplicación está viva' })
  liveness(): Promise<HealthCheckResult> {
    // No toca dependencias externas. Si responde, el proceso está vivo.
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe — la app puede servir tráfico' })
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.db.pingCheck('database', { timeout: 1500 }),
    ]);
  }
}
