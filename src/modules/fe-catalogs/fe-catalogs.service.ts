import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import NodeCache from 'node-cache';

import type { FeConfig } from '@/config/fe.config';

/** Item genérico de un catálogo simple de la DIAN. */
export interface FeCatalogItem {
  id: number;
  name: string;
  code: string | null;
}

/** Municipio con su departamento (para mostrar "Ciudad, Departamento"). */
export interface FeMunicipality {
  id: number;
  name: string;
  code: string | null;
  department: string | null;
}

/** Los 4 catálogos simples que necesita el formulario de cliente. */
export interface FeSimpleCatalogs {
  documentTypes: FeCatalogItem[];
  organizations: FeCatalogItem[];
  regimes: FeCatalogItem[];
  liabilities: FeCatalogItem[];
}

/** Forma cruda de un item de catálogo tal como lo devuelve APIDIAN. */
interface RawCatalogRow {
  id: number | string;
  name?: string;
  code?: string | number | null;
  department?: { name?: string | null } | null;
}

const SIMPLE_ENDPOINTS = {
  documentTypes: 'info_initial/type_document_identification',
  organizations: 'info_initial/type_organizations',
  regimes: 'info_initial/type_regimes',
  liabilities: 'info_initial/type_liabilities',
} as const;

const MUNICIPALITIES_ENDPOINT = 'info_initial/municipalities';

// Claves del caché. Los catálogos cambian rarísimo; se guardan enteros y el
// filtrado de municipios se hace en memoria sobre la lista cacheada.
const CACHE_KEYS = {
  simple: 'fe:catalogs:simple',
  municipalities: 'fe:catalogs:municipalities',
} as const;

/** Cuántos municipios se devuelven como máximo por búsqueda (combobox). */
const MUNICIPALITY_SEARCH_LIMIT = 50;

/**
 * Consume los catálogos de Facturación Electrónica del API externo (APIDIAN) y
 * los cachea en memoria. pos_api NO tiene tablas de catálogos de la DIAN: la
 * fuente de la verdad es APIDIAN (regla del proyecto). Este servicio es solo un
 * proxy con caché para que el renderer de placepos (que en cloud solo habla con
 * pos_api) pueda poblar los selects del formulario de cliente.
 *
 * Caché POR INSTANCIA (NodeCache), igual que las URLs firmadas de imágenes: con
 * un solo contenedor alcanza; con varias réplicas cada una calienta la suya.
 */
@Injectable()
export class FeCatalogsService {
  private readonly logger = new Logger(FeCatalogsService.name);
  private readonly cache: NodeCache;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService) {
    const config = configService.getOrThrow<FeConfig>('fe');
    this.baseUrl = config.apiBaseUrl;
    this.timeoutMs = config.timeoutMs;
    this.cache = new NodeCache({
      stdTTL: config.catalogCacheTtlSeconds,
      // Los catálogos son arrays inmutables: no clonar en cada lectura.
      useClones: false,
      checkperiod: 600,
    });
  }

  /** Los 4 catálogos simples (una sola llamada para el formulario). */
  async getSimpleCatalogs(): Promise<FeSimpleCatalogs> {
    const cached = this.cache.get<FeSimpleCatalogs>(CACHE_KEYS.simple);
    if (cached) {
      return cached;
    }

    // Se piden en paralelo; si cualquiera falla, el formulario no puede
    // funcionar, así que se propaga un 503 (APIDIAN caído/no accesible).
    const [documentTypes, organizations, regimes, liabilities] = await Promise.all([
      this.fetchCatalog(SIMPLE_ENDPOINTS.documentTypes),
      this.fetchCatalog(SIMPLE_ENDPOINTS.organizations),
      this.fetchCatalog(SIMPLE_ENDPOINTS.regimes),
      this.fetchCatalog(SIMPLE_ENDPOINTS.liabilities),
    ]);

    const result: FeSimpleCatalogs = { documentTypes, organizations, regimes, liabilities };
    this.cache.set(CACHE_KEYS.simple, result);
    return result;
  }

  /**
   * Municipios filtrados por texto (nombre o departamento), acotados a
   * {@link MUNICIPALITY_SEARCH_LIMIT}. Sin `search` devuelve el primer tramo
   * (para que el combobox muestre algo al abrir).
   */
  async searchMunicipalities(search?: string): Promise<FeMunicipality[]> {
    const all = await this.getMunicipalities();
    const term = search?.trim().toLowerCase();
    if (!term) {
      return all.slice(0, MUNICIPALITY_SEARCH_LIMIT);
    }
    const matches: FeMunicipality[] = [];
    for (const m of all) {
      const haystack = `${m.name} ${m.department ?? ''}`.toLowerCase();
      if (haystack.includes(term)) {
        matches.push(m);
        if (matches.length >= MUNICIPALITY_SEARCH_LIMIT) {
          break;
        }
      }
    }
    return matches;
  }

  /**
   * Resuelve un municipio por su id (para pintar el municipio ya guardado de un
   * cliente al editarlo, sin que el usuario tenga que volver a buscarlo).
   */
  async findMunicipalityById(id: number): Promise<FeMunicipality | null> {
    const all = await this.getMunicipalities();
    return all.find((m) => m.id === id) ?? null;
  }

  private async getMunicipalities(): Promise<FeMunicipality[]> {
    const cached = this.cache.get<FeMunicipality[]>(CACHE_KEYS.municipalities);
    if (cached) {
      return cached;
    }
    const rows = await this.fetchJson(MUNICIPALITIES_ENDPOINT);
    const municipalities = rows.map(
      (row): FeMunicipality => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
        code: row.code != null ? String(row.code) : null,
        department: row.department?.name ?? null,
      }),
    );
    this.cache.set(CACHE_KEYS.municipalities, municipalities);
    return municipalities;
  }

  private async fetchCatalog(endpoint: string): Promise<FeCatalogItem[]> {
    const rows = await this.fetchJson(endpoint);
    return rows.map(
      (row): FeCatalogItem => ({
        id: Number(row.id),
        name: String(row.name ?? ''),
        code: row.code != null ? String(row.code) : null,
      }),
    );
  }

  /**
   * GET al API de APIDIAN con timeout duro. Cualquier fallo (red, timeout,
   * status !=2xx, cuerpo no-array) se traduce a 503: el catálogo es indispensable
   * y no hay fallback local (no duplicamos la tabla de la DIAN).
   */
  private async fetchJson(endpoint: string): Promise<RawCatalogRow[]> {
    const url = `${this.baseUrl}/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`APIDIAN respondió ${response.status} en ${endpoint}`);
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) {
        throw new Error(`APIDIAN devolvió un cuerpo no-array en ${endpoint}`);
      }
      return body as RawCatalogRow[];
    } catch (error) {
      this.logger.error(
        `No se pudo obtener el catálogo de FE (${endpoint}): ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'No se pudieron cargar los catálogos de Facturación Electrónica. Intenta de nuevo en un momento.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Solo para tests/diagnóstico: vacía el caché. */
  clearCache(): void {
    this.cache.flushAll();
  }
}
