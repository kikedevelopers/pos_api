import { Test, type TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let controller: AppController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  describe('getInfo', () => {
    it('debe devolver información básica de la API', () => {
      const info = controller.getInfo();
      expect(info).toBeDefined();
      expect(info.name).toBe('POS API');
      expect(typeof info.version).toBe('string');
      expect(typeof info.environment).toBe('string');
      expect(typeof info.uptime).toBe('number');
    });
  });
});
