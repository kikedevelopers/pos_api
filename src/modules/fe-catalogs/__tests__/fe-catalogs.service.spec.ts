import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { FeConfig } from '@/config/fe.config';
import { FeCatalogsService } from '../fe-catalogs.service';

const FE_CONFIG: FeConfig = {
  apiBaseUrl: 'http://apidian.test/api',
  timeoutMs: 5000,
  catalogCacheTtlSeconds: 3600,
};

function makeConfigService(): ConfigService {
  return { getOrThrow: jest.fn(() => FE_CONFIG) } as unknown as ConfigService;
}

/** Respuesta OK con un array JSON. */
function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

// Respuestas por endpoint (la parte final de la URL).
const CATALOG_BODIES: Record<string, unknown> = {
  type_document_identification: [{ id: 6, name: 'NIT', code: '31' }],
  type_organizations: [{ id: 2, name: 'Persona Natural', code: '2' }],
  type_regimes: [{ id: 2, name: 'No Responsable de IVA', code: '49' }],
  type_liabilities: [{ id: 117, name: 'No responsable', code: 'R-99-PN' }],
  municipalities: [
    { id: 1, name: 'Medellín', code: '05001', department: { name: 'Antioquia' } },
    { id: 2, name: 'Bogotá', code: '11001', department: { name: 'Bogotá D.C.' } },
    { id: 3, name: 'Envigado', code: '05266', department: { name: 'Antioquia' } },
  ],
};

function installFetchMock(): jest.Mock {
  const mock = jest.fn((url: string) => {
    const key = Object.keys(CATALOG_BODIES).find((k) => url.endsWith(k));
    if (!key) {
      return Promise.resolve({ ok: false, status: 404 } as unknown as Response);
    }
    return Promise.resolve(okJson(CATALOG_BODIES[key]));
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('FeCatalogsService', () => {
  let service: FeCatalogsService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = installFetchMock();
    service = new FeCatalogsService(makeConfigService());
  });

  afterEach(() => jest.restoreAllMocks());

  describe('getSimpleCatalogs', () => {
    it('trae y normaliza los 4 catálogos simples', async () => {
      const catalogs = await service.getSimpleCatalogs();

      expect(catalogs.documentTypes).toEqual([{ id: 6, name: 'NIT', code: '31' }]);
      expect(catalogs.organizations).toEqual([{ id: 2, name: 'Persona Natural', code: '2' }]);
      expect(catalogs.regimes).toEqual([{ id: 2, name: 'No Responsable de IVA', code: '49' }]);
      expect(catalogs.liabilities).toEqual([{ id: 117, name: 'No responsable', code: 'R-99-PN' }]);
      // Cuatro llamadas: una por catálogo.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('cachea: la segunda llamada no vuelve a golpear el API', async () => {
      await service.getSimpleCatalogs();
      fetchMock.mockClear();
      await service.getSimpleCatalogs();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('propaga 503 si un endpoint responde !=2xx', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({ ok: false, status: 500 } as unknown as Response),
      ) as unknown as typeof fetch;
      await expect(service.getSimpleCatalogs()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('propaga 503 si el cuerpo no es un array', async () => {
      global.fetch = jest.fn(() => Promise.resolve(okJson({ oops: true }))) as unknown as typeof fetch;
      await expect(service.getSimpleCatalogs()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('searchMunicipalities', () => {
    it('sin término devuelve el primer tramo, con departamento normalizado', async () => {
      const all = await service.searchMunicipalities();
      expect(all).toHaveLength(3);
      expect(all[0]).toEqual({ id: 1, name: 'Medellín', code: '05001', department: 'Antioquia' });
    });

    it('filtra por nombre (case-insensitive)', async () => {
      const result = await service.searchMunicipalities('bogot');
      expect(result.map((m) => m.name)).toEqual(['Bogotá']);
    });

    it('filtra por departamento', async () => {
      const result = await service.searchMunicipalities('antioquia');
      expect(result.map((m) => m.name)).toEqual(['Medellín', 'Envigado']);
    });

    it('cachea la lista de municipios entre búsquedas', async () => {
      await service.searchMunicipalities('a');
      fetchMock.mockClear();
      await service.searchMunicipalities('b');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('findMunicipalityById', () => {
    it('resuelve un municipio por id', async () => {
      const m = await service.findMunicipalityById(2);
      expect(m).toEqual({ id: 2, name: 'Bogotá', code: '11001', department: 'Bogotá D.C.' });
    });

    it('devuelve null si el id no existe', async () => {
      expect(await service.findMunicipalityById(9999)).toBeNull();
    });
  });
});
