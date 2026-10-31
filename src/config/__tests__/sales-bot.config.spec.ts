import salesBotConfig, { type SalesBotConfig } from '../sales-bot.config';

const load = (): SalesBotConfig => salesBotConfig() as SalesBotConfig;

describe('sales-bot.config — rondas de herramientas', () => {
  const original = process.env.SALES_BOT_MAX_TOOL_ROUNDS;
  afterEach(() => {
    if (original === undefined) delete process.env.SALES_BOT_MAX_TOOL_ROUNDS;
    else process.env.SALES_BOT_MAX_TOOL_ROUNDS = original;
  });

  it('por defecto 6 (cambiar un pedido ya hecho encadena varias herramientas)', () => {
    delete process.env.SALES_BOT_MAX_TOOL_ROUNDS;
    expect(load().maxToolRounds).toBe(6);
  });

  it('se puede ajustar por variable de entorno', () => {
    process.env.SALES_BOT_MAX_TOOL_ROUNDS = '8';
    expect(load().maxToolRounds).toBe(8);
  });
});
