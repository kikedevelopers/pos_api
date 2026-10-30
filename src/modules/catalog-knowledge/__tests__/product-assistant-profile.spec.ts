import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';

import type { GeminiClient, GeminiRoundResult } from '@/modules/ai/internal/gemini-client';

import type { ProductAssistantProfileEntity } from '../entities/product-assistant-profile.entity';
import { ProductAssistantProfileService } from '../product-assistant-profile.service';
import { SuggestAssistantProfileAction } from '../suggest-assistant-profile.action';

const COMPANY = 7;

type ProductRow = {
  id: string;
  company_id: string;
  parent_id: string | null;
  is_archived: boolean;
};

const makeService = (options: {
  product?: ProductRow | null;
  existing?: Partial<ProductAssistantProfileEntity> | null;
  accessible?: Array<{ id: string; name: string }>;
}) => {
  const product: ProductRow | null =
    options.product === undefined
      ? { id: '5', company_id: String(COMPANY), parent_id: null, is_archived: false }
      : options.product;
  const query = jest.fn(async (sql: string) => {
    if (sql.startsWith('SELECT id, company_id, parent_id, is_archived FROM products')) {
      return product ? [product] : [];
    }
    return options.accessible ?? [];
  });
  const repo = {
    findOne: jest.fn().mockResolvedValue(options.existing ?? null),
    create: jest.fn((partial: Partial<ProductAssistantProfileEntity>) => ({ ...partial })),
    save: jest.fn(async (entity: ProductAssistantProfileEntity) => ({
      ...entity,
      updated_at: new Date('2026-10-30T12:00:00Z'),
    })),
  };
  const service = new ProductAssistantProfileService(
    repo as unknown as Repository<ProductAssistantProfileEntity>,
    { query } as unknown as DataSource,
  );
  return { service, repo, query };
};

describe('ProductAssistantProfileService.get', () => {
  it('sin ficha devuelve una vacía', async () => {
    const { service } = makeService({});
    await expect(service.get(COMPANY, 5)).resolves.toEqual({
      product_id: 5,
      description: '',
      uses: [],
      attributes: [],
      aliases: [],
      related: [],
      updated_at: null,
    });
  });

  it('devuelve la ficha con el nombre de cada relacionado y omite los que ya no existen', async () => {
    const { service } = makeService({
      existing: {
        description: 'Contenedor P1',
        uses: ['hamburguesa'],
        attributes: [{ name: 'compartimentos', value: '1' }],
        aliases: [],
        related: [
          { product_id: 9, kind: 'upgrade' },
          { product_id: 10, kind: 'complement' },
        ],
        updated_at: new Date('2026-10-30T12:00:00Z'),
      },
      accessible: [{ id: '9', name: 'CONTENEDOR J2' }],
    });
    const view = await service.get(COMPANY, 5);
    expect(view.related).toEqual([{ product_id: 9, kind: 'upgrade', name: 'CONTENEDOR J2' }]);
    expect(view.updated_at).toBe('2026-10-30T12:00:00.000Z');
  });

  it('producto de otro negocio, archivado o inexistente → 404', async () => {
    for (const product of [
      { id: '5', company_id: '99', parent_id: null, is_archived: false },
      { id: '5', company_id: String(COMPANY), parent_id: null, is_archived: true },
      null,
    ]) {
      const { service } = makeService({ product });
      await expect(service.get(COMPANY, 5)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('una presentación no tiene ficha propia → 400', async () => {
    const { service } = makeService({
      product: { id: '6', company_id: String(COMPANY), parent_id: '5', is_archived: false },
    });
    await expect(service.get(COMPANY, 6)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProductAssistantProfileService.update', () => {
  it('crea la ficha saneada', async () => {
    const { service, repo } = makeService({ accessible: [{ id: '9', name: 'CONTENEDOR J2' }] });
    const view = await service.update(COMPANY, 5, {
      description: '  Contenedor de una porción ',
      uses: ['hamburguesa', 'hamburguesa', ''],
      attributes: [{ name: 'compartimentos', value: 1 }],
      aliases: ['portacomida'],
      related: [{ product_id: 9, kind: 'upgrade' }],
    });
    expect(repo.create).toHaveBeenCalledWith({ company_id: '7', product_id: '5' });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Contenedor de una porción',
        uses: ['hamburguesa'],
        attributes: [{ name: 'compartimentos', value: '1' }],
        related: [{ product_id: 9, kind: 'upgrade' }],
      }),
    );
    expect(view.related).toEqual([{ product_id: 9, kind: 'upgrade', name: 'CONTENEDOR J2' }]);
  });

  it('actualiza la ficha existente', async () => {
    const { service, repo } = makeService({
      existing: { id: '1', product_id: '5', description: 'viejo' },
    });
    await service.update(COMPANY, 5, { description: 'nuevo' });
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', description: 'nuevo' }),
    );
  });

  it('rechaza relacionados que el negocio no puede vender (otro negocio o archivado)', async () => {
    const { service, repo } = makeService({ accessible: [] });
    await expect(
      service.update(COMPANY, 5, { related: [{ product_id: 77, kind: 'complement' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('ignora relacionarse consigo mismo', async () => {
    const { service, repo } = makeService({});
    await service.update(COMPANY, 5, { related: [{ product_id: 5, kind: 'upgrade' }] });
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ related: [] }));
  });

  it('no guarda en productos ajenos ni en presentaciones', async () => {
    const foreign = makeService({
      product: { id: '5', company_id: '99', parent_id: null, is_archived: false },
    });
    await expect(foreign.service.update(COMPANY, 5, {})).rejects.toBeInstanceOf(NotFoundException);
    const presentation = makeService({
      product: { id: '6', company_id: String(COMPANY), parent_id: '5', is_archived: false },
    });
    await expect(presentation.service.update(COMPANY, 6, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(foreign.repo.save).not.toHaveBeenCalled();
    expect(presentation.repo.save).not.toHaveBeenCalled();
  });
});

describe('SuggestAssistantProfileAction', () => {
  const productRow = {
    name: 'TAJIN X 45g',
    company_id: String(COMPANY),
    parent_id: null,
    is_archived: false,
    category: 'Condimentos',
    business: 'Esencia & Grano',
    presentations: null,
  };

  const makeAction = (row: unknown, round: Partial<GeminiRoundResult>, enabled = true) => {
    const streamRound = jest
      .fn()
      .mockResolvedValue({ text: '', parts: [], functionCalls: [], ...round });
    const gemini = {
      isEnabled: () => enabled,
      resolveModel: () => 'gemini-flash-lite-latest',
      streamRound,
    } as unknown as GeminiClient;
    const dataSource = {
      query: jest.fn().mockResolvedValue(row ? [row] : []),
    } as unknown as DataSource;
    return { action: new SuggestAssistantProfileAction(dataSource, gemini), streamRound };
  };

  it('propone la ficha (sin guardar) y pide JSON sin desactivar el razonamiento', async () => {
    const { action, streamRound } = makeAction(productRow, {
      text: '{"description":"Condimento de chile y limón","uses":["frutas"],"attributes":[],"aliases":["polvo para micheladas"]}',
    });
    await expect(action.execute(COMPANY, 5)).resolves.toEqual({
      description: 'Condimento de chile y limón',
      uses: ['frutas'],
      attributes: [],
      aliases: ['polvo para micheladas'],
    });
    const [body] = streamRound.mock.calls[0];
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    // El modelo rechaza thinkingBudget 0 (400).
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
    expect(body.contents[0].parts[0].text).toContain('Producto: TAJIN X 45g');
  });

  it('respuesta inválida o error de la IA → 503 amable', async () => {
    const bad = makeAction(productRow, { text: 'no sé' });
    await expect(bad.action.execute(COMPANY, 5)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    const failed = makeAction(productRow, { error: 'cuota' });
    await expect(failed.action.execute(COMPANY, 5)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('sin IA configurada → 503 sin consultar', async () => {
    const { action, streamRound } = makeAction(productRow, {}, false);
    await expect(action.execute(COMPANY, 5)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(streamRound).not.toHaveBeenCalled();
  });

  it('producto ajeno, archivado, presentación o inexistente → 404 sin llamar a la IA', async () => {
    for (const row of [
      { ...productRow, company_id: '99' },
      { ...productRow, is_archived: true },
      { ...productRow, parent_id: '1' },
      null,
    ]) {
      const { action, streamRound } = makeAction(row, {});
      await expect(action.execute(COMPANY, 5)).rejects.toBeInstanceOf(NotFoundException);
      expect(streamRound).not.toHaveBeenCalled();
    }
  });
});
