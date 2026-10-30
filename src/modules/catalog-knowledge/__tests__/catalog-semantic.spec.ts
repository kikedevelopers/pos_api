import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import { CatalogIndexScheduler, INDEX_TEXTS_PER_RUN } from '../catalog-index.scheduler';
import { CatalogSemanticService, MIN_SEMANTIC_SCORE } from '../catalog-semantic.service';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  GeminiEmbeddingsClient,
} from '../internal/gemini-embeddings.client';
import { buildFamilyText, textHash } from '../internal/profile';

const okJson = (body: unknown): Response =>
  ({ ok: true, json: async () => body, text: async () => '' }) as unknown as Response;

const configWith = (apiKey: string): ConfigService =>
  ({
    getOrThrow: () => ({
      apiKey,
      baseUrl: 'https://gemini.test/v1beta',
      requestTimeoutMs: 5000,
    }),
  }) as unknown as ConfigService;

describe('GeminiEmbeddingsClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('pide documentos con el modelo, la tarea y las dimensiones, y normaliza', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okJson({ embeddings: [{ values: [3, 4] }, { values: [0, 2] }] }));
    const client = new GeminiEmbeddingsClient(configWith('k'));

    const vectors = await client.embedDocuments(['a', 'b']);

    expect(vectors?.[0][0]).toBeCloseTo(0.6);
    expect(vectors?.[1]).toEqual([0, 1]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://gemini.test/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=k`,
    );
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.requests[0]).toEqual({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text: 'a' }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: EMBEDDING_DIMENSIONS,
    });
  });

  it('la consulta usa RETRIEVAL_QUERY', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(okJson({ embeddings: [{ values: [1, 0] }] }));
    await new GeminiEmbeddingsClient(configWith('k')).embedQuery('para asados');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.requests[0].taskType).toBe('RETRIEVAL_QUERY');
  });

  it('parte en lotes de 100', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const count = JSON.parse((init as RequestInit).body as string).requests.length;
      return okJson({ embeddings: Array.from({ length: count }, () => ({ values: [1] })) });
    });
    const vectors = await new GeminiEmbeddingsClient(configWith('k')).embedDocuments(
      Array.from({ length: 150 }, (_, i) => `t${i}`),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vectors).toHaveLength(150);
  });

  it('error HTTP (p. ej. 429 de cuota), red caída o respuesta incompleta → null', async () => {
    const client = new GeminiEmbeddingsClient(configWith('k'));
    jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'quota',
    } as unknown as Response);
    await expect(client.embedDocuments(['a'])).resolves.toBeNull();

    jest.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('offline'));
    await expect(client.embedQuery('a')).resolves.toBeNull();

    jest.spyOn(global, 'fetch').mockResolvedValueOnce(okJson({ embeddings: [] }));
    await expect(client.embedDocuments(['a'])).resolves.toBeNull();
  });

  it('sin llave no llama a Google', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const client = new GeminiEmbeddingsClient(configWith(''));
    expect(client.isEnabled()).toBe(false);
    await expect(client.embedQuery('a')).resolves.toBeNull();
    await expect(client.embedDocuments([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Fila de familia como la devuelve `loadFamilies`. */
const family = (id: number, name: string, overrides: Record<string, unknown> = {}) => ({
  id: String(id),
  company_id: '7',
  name,
  category: null,
  presentations: null,
  description: null,
  uses: null,
  attributes: null,
  aliases: null,
  text_hash: null,
  model: null,
  ...overrides,
});

const hashOf = (name: string): string =>
  textHash(buildFamilyText({ name, category: null, presentations: [], profile: null }));

const makeSemantic = (families: unknown[], storedVectors: unknown[] = []) => {
  const managerQuery = jest.fn().mockResolvedValue([]);
  const query = jest.fn(async (sql: string) =>
    sql.includes('FROM product_search_embeddings e') ? storedVectors : families,
  );
  const dataSource = {
    query,
    transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) => fn({ query: managerQuery })),
  } as unknown as DataSource;
  const embeddings = {
    isEnabled: jest.fn().mockReturnValue(true),
    embedDocuments: jest.fn(
      async (texts: string[]): Promise<number[][] | null> => texts.map(() => [1, 0]),
    ),
    embedQuery: jest.fn().mockResolvedValue([1, 0]),
  };
  const service = new CatalogSemanticService(
    dataSource,
    embeddings as unknown as GeminiEmbeddingsClient,
  );
  return { service, query, managerQuery, embeddings };
};

describe('CatalogSemanticService.indexCompany', () => {
  it('solo indexa familias nuevas o cuyo texto cambió', async () => {
    const h = makeSemantic([
      family(1, 'Sin vector'),
      family(2, 'Al día', { text_hash: hashOf('Al día'), model: EMBEDDING_MODEL }),
      family(3, 'Cambió', { text_hash: 'viejo', model: EMBEDDING_MODEL }),
      family(4, 'Otro modelo', { text_hash: hashOf('Otro modelo'), model: 'viejo-modelo' }),
    ]);

    const result = await h.service.indexCompany(7, 10);

    expect(result).toEqual({ indexed: 3, pending: 0 });
    const texts = h.embeddings.embedDocuments.mock.calls[0][0];
    expect(texts.map((t) => t.split('\n')[0])).toEqual([
      'Producto: Sin vector',
      'Producto: Cambió',
      'Producto: Otro modelo',
    ]);
    expect(h.managerQuery).toHaveBeenCalledTimes(3);
    const [sql, params] = h.managerQuery.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(product_id\) DO UPDATE/);
    expect(params).toEqual(['7', '1', EMBEDDING_MODEL, hashOf('Sin vector'), [1, 0]]);
  });

  it('respeta el tope y reporta lo pendiente', async () => {
    const h = makeSemantic([family(1, 'A'), family(2, 'B'), family(3, 'C')]);
    await expect(h.service.indexCompany(7, 2)).resolves.toEqual({ indexed: 2, pending: 1 });
  });

  it('lo recién editado va primero', async () => {
    const h = makeSemantic([family(1, 'A'), family(2, 'B'), family(3, 'C')]);
    await h.service.indexCompany(7, 1, [3]);
    expect(h.managerQuery.mock.calls[0][1][1]).toBe('3');
  });

  it('incluye la ficha del producto en el texto indexado', async () => {
    const h = makeSemantic([
      family(1, 'Contenedor J2', {
        description: 'Dos compartimentos',
        uses: ['hamburguesa con papas'],
        attributes: [{ name: 'compartimentos', value: '2' }],
        aliases: ['portacomida'],
      }),
    ]);
    await h.service.indexCompany(7, 5);
    const [text] = h.embeddings.embedDocuments.mock.calls[0][0];
    expect(text).toContain('Sirve para: hamburguesa con papas');
    expect(text).toContain('Características: compartimentos: 2');
  });

  it('sin cambios no llama a la IA', async () => {
    const h = makeSemantic([
      family(2, 'Al día', { text_hash: hashOf('Al día'), model: EMBEDDING_MODEL }),
    ]);
    await expect(h.service.indexCompany(7)).resolves.toEqual({ indexed: 0, pending: 0 });
    expect(h.embeddings.embedDocuments).not.toHaveBeenCalled();
  });

  it('si Google falla, no escribe nada y deja todo pendiente', async () => {
    const h = makeSemantic([family(1, 'A'), family(2, 'B')]);
    h.embeddings.embedDocuments.mockResolvedValue(null);
    await expect(h.service.indexCompany(7)).resolves.toEqual({ indexed: 0, pending: 2 });
    expect(h.managerQuery).not.toHaveBeenCalled();
  });

  it('sin IA configurada no hace nada', async () => {
    const h = makeSemantic([family(1, 'A')]);
    h.embeddings.isEnabled.mockReturnValue(false);
    await expect(h.service.indexCompany(7)).resolves.toEqual({ indexed: 0, pending: 0 });
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('CatalogSemanticService.search', () => {
  const stored = [
    { product_id: '1', embedding: [1, 0] },
    { product_id: '2', embedding: [0.999, 0.045] },
    { product_id: '3', embedding: [0, 1] },
  ];

  it('devuelve las familias más parecidas sobre el umbral, de mayor a menor', async () => {
    const h = makeSemantic([], stored);
    const result = await h.service.search(7, 'para asados', 5);
    expect(result.map((r) => r.id)).toEqual([1, 2]);
    expect(result.every((r) => r.score >= MIN_SEMANTIC_SCORE)).toBe(true);
  });

  it('cachea los vectores del negocio (una sola lectura de BD)', async () => {
    const h = makeSemantic([], stored);
    await h.service.search(7, 'a');
    await h.service.search(7, 'b');
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('indexar invalida la caché', async () => {
    const h = makeSemantic([family(9, 'Nuevo')], stored);
    await h.service.search(7, 'a');
    await h.service.indexCompany(7);
    await h.service.search(7, 'a');
    const vectorReads = h.query.mock.calls.filter(([sql]) =>
      sql.includes('FROM product_search_embeddings e'),
    );
    expect(vectorReads).toHaveLength(2);
  });

  it('necesidad vacía, sin IA o sin vector de la consulta → vacío', async () => {
    const h = makeSemantic([], stored);
    await expect(h.service.search(7, '   ')).resolves.toEqual([]);
    h.embeddings.embedQuery.mockResolvedValueOnce(null);
    await expect(h.service.search(7, 'algo')).resolves.toEqual([]);
    h.embeddings.isEnabled.mockReturnValue(false);
    await expect(h.service.search(7, 'algo')).resolves.toEqual([]);
  });
});

describe('CatalogIndexScheduler', () => {
  const makeScheduler = (companies: string[]) => {
    const dataSource = {
      query: jest.fn().mockResolvedValue(companies.map((company_id) => ({ company_id }))),
    } as unknown as DataSource;
    const semantic = {
      isEnabled: jest.fn().mockReturnValue(true),
      indexCompany: jest.fn(),
    };
    const scheduler = new CatalogIndexScheduler(
      dataSource,
      semantic as unknown as CatalogSemanticService,
    );
    return { scheduler, semantic };
  };

  it('reparte el presupuesto por minuto entre los negocios', async () => {
    const h = makeScheduler(['1', '2', '3']);
    h.semantic.indexCompany
      .mockResolvedValueOnce({ indexed: 40, pending: 0 })
      .mockResolvedValueOnce({ indexed: 20, pending: 5 });
    await h.scheduler.run();
    expect(h.semantic.indexCompany.mock.calls).toEqual([
      [1, INDEX_TEXTS_PER_RUN],
      [2, INDEX_TEXTS_PER_RUN - 40],
    ]);
  });

  it('si Google rechaza (nada indexado y hay pendientes), corta la corrida', async () => {
    const h = makeScheduler(['1', '2']);
    h.semantic.indexCompany.mockResolvedValueOnce({ indexed: 0, pending: 10 });
    await h.scheduler.run();
    expect(h.semantic.indexCompany).toHaveBeenCalledTimes(1);
  });

  it('un negocio que falla no detiene a los demás', async () => {
    const h = makeScheduler(['1', '2']);
    h.semantic.indexCompany
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ indexed: 1, pending: 0 });
    await expect(h.scheduler.run()).resolves.toBeUndefined();
    expect(h.semantic.indexCompany).toHaveBeenCalledTimes(2);
  });

  it('sin IA no consulta nada', async () => {
    const h = makeScheduler(['1']);
    h.semantic.isEnabled.mockReturnValue(false);
    await h.scheduler.run();
    expect(h.semantic.indexCompany).not.toHaveBeenCalled();
  });
});
