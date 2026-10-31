import salesBotConfig, { type SalesBotConfig } from '../sales-bot.config';
import { validationSchema } from '../validation.schema';

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

describe('validationSchema — SALES_BOT_MAX_TOOL_ROUNDS', () => {
  // Nest copia los defaults de la validación a process.env: si aquí dijera 4,
  // regirían 4 rondas aunque sales-bot.config diga 6.
  it('el default de la validación coincide con el de la config (6)', () => {
    const { value } = validationSchema.extract('SALES_BOT_MAX_TOOL_ROUNDS').validate(undefined);
    expect(value).toBe(6);
  });

  it('rechaza más de 10 rondas', () => {
    const { error } = validationSchema.extract('SALES_BOT_MAX_TOOL_ROUNDS').validate(11);
    expect(error).toBeDefined();
  });
});
