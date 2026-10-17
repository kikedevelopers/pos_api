import {
  MAX_TRACKED_REQUESTS,
  OFFERED_REFERENCES_TTL_MS,
  OfferedReferences,
} from '../internal/offered-references';
import { describeCustomerOption } from '../actions/run-ai-sale-tool.action';
import { rankSimilarNames } from '../internal/sale-product-matching';
import { buildCustomerFuzzySql } from '../internal/sale-tool-sql';

/**
 * Entre turnos el modelo no conserva los ids (el historial es texto) y los
 * inventa: un id solo vale si la herramienta lo ofreció en ESA petición.
 */
describe('OfferedReferences', () => {
  it('solo acepta ids ofrecidos en la MISMA petición y del MISMO tipo', () => {
    const refs = new OfferedReferences();
    refs.remember('req-1', 'product', [10, 11]);
    refs.remember('req-1', 'customer', [7]);

    expect(refs.wasOffered('req-1', 'product', 10)).toBe(true);
    expect(refs.wasOffered('req-1', 'customer', 7)).toBe(true);
    expect(refs.wasOffered('req-1', 'product', 7)).toBe(false);
    expect(refs.wasOffered('req-1', 'product', 99)).toBe(false);
    expect(refs.wasOffered('req-2', 'product', 10)).toBe(false);
  });

  it('acumula lo ofrecido en varias llamadas de la misma petición', () => {
    const refs = new OfferedReferences();
    refs.remember('req', 'product', [1]);
    refs.remember('req', 'product', [2]);
    expect(refs.wasOffered('req', 'product', 1)).toBe(true);
    expect(refs.wasOffered('req', 'product', 2)).toBe(true);
  });

  it('vence con el tiempo', () => {
    let now = 1_000;
    const refs = new OfferedReferences(() => now);
    refs.remember('req', 'product', [1]);
    now += OFFERED_REFERENCES_TTL_MS + 1;
    expect(refs.wasOffered('req', 'product', 1)).toBe(false);
  });

  it('no crece sin fin: descarta las peticiones más viejas', () => {
    const refs = new OfferedReferences(() => 1_000);
    for (let i = 0; i <= MAX_TRACKED_REQUESTS; i += 1) {
      refs.remember(`req-${i}`, 'product', [i]);
    }
    expect(refs.wasOffered('req-0', 'product', 0)).toBe(false);
    expect(refs.wasOffered(`req-${MAX_TRACKED_REQUESTS}`, 'product', MAX_TRACKED_REQUESTS)).toBe(
      true,
    );
  });
});

describe('rankSimilarNames', () => {
  const NAMES = [
    'JHOANA MOGOLLON',
    'JHOANA PERDOMO',
    'IRMA MOGOLLON',
    'JHOANNA GARCIA',
    'MARÍA MUÑOZ',
  ];
  const rank = (query: string): string[] => rankSimilarNames(query, NAMES, (name) => name);

  it('tolera un error de tipeo y exige TODAS las palabras dichas', () => {
    expect(rank('Jhoanna Mogollon')).toEqual(['JHOANA MOGOLLON']);
    expect(rank('maria munos')).toEqual(['MARÍA MUÑOZ']);
  });

  it('con una sola palabra devuelve todos los parecidos, los exactos primero', () => {
    expect(rank('Jhoanna')).toEqual(['JHOANNA GARCIA', 'JHOANA MOGOLLON', 'JHOANA PERDOMO']);
  });

  it('sin parecidos o sin palabras útiles → vacío', () => {
    expect(rank('Zacarías')).toEqual([]);
    expect(rank('de la')).toEqual([]);
  });
});

describe('buildCustomerFuzzySql', () => {
  it('busca por el inicio de cada palabra, acotado a la company y a activos', () => {
    const fuzzy = buildCustomerFuzzySql(13, 'Jhoanna Mogollón');
    expect(fuzzy?.params).toEqual(['13', ['%jho%', '%mog%']]);
    expect(fuzzy?.sql).toMatch(/c\.company_id = \$1/);
    expect(fuzzy?.sql).toMatch(/c\.is_archived = false/);
  });

  it('sin palabras de 3+ letras no consulta', () => {
    expect(buildCustomerFuzzySql(13, 'jo y')).toBeNull();
  });
});

describe('describeCustomerOption', () => {
  it('solo muestra los datos que existen (nunca un documento inventado)', () => {
    expect(describeCustomerOption({ name: 'JHOANA MOGOLLON', doc_number: null, phone: null })).toBe(
      'JHOANA MOGOLLON',
    );
    expect(
      describeCustomerOption({ name: 'JUAN PEREZ', doc_number: ' 1110 ', phone: '300 1234567' }),
    ).toBe('JUAN PEREZ · Doc. 1110 · Tel. 300 1234567');
    expect(describeCustomerOption({ name: 'ANA', doc_number: '', phone: '  ' })).toBe('ANA');
  });
});
