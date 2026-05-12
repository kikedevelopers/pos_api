import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from './common/decorators/public.decorator';
import { AppService, type AppInfo } from './app.service';

@ApiTags('app')
@Public()
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Información básica de la API' })
  getInfo(): AppInfo {
    return this.appService.getInfo();
  }
}
