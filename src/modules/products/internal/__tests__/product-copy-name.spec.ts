import {
  COPY_LABEL,
  MAX_COPY_ATTEMPTS,
  buildCopyName,
  resolveCopyName,
  stripCopySuffix,
} from '../product-copy-name';

/**
 * Espejo del suite de placepos (`productCopyName.test.ts`). Ambos repos DEBEN
 * generar el MISMO nombre para el mismo catálogo: si divergen, duplicar el
 * mismo producto daría nombres distintos según el POS esté en local o en cloud.
 */

/**
 * Predicado de "nombre ocupado" en memoria. Reproduce la comparación del SQL
 * (case-insensible) para verificar el CONTRATO de la numeración sin BD.
 */
const takenFrom = (names: string[]): jest.Mock<Promise<boolean>, [string]> => {
  const set = new Set(names.map((n) => n.trim().toLowerCase()));
  return jest.fn((candidate: string) => Promise.resolve(set.has(candidate.trim().toLowerCase())));
};

/** Predicado que reporta SIEMPRE ocupado: fuerza el agotamiento de intentos. */
const alwaysTaken = (): jest.Mock<Promise<boolean>, []> => jest.fn(() => Promise.resolve(true));

describe('stripCopySuffix', () => {
  it('deja intacto un nombre sin sufijo de copia', () => {
    expect(stripCopySuffix('ARROZ DIANA')).toBe('ARROZ DIANA');
  });

  it('quita el sufijo COPIA', () => {
    expect(stripCopySuffix('ARROZ DIANA COPIA')).toBe('ARROZ DIANA');
  });

  it('quita el sufijo COPIA numerado', () => {
    expect(stripCopySuffix('ARROZ DIANA COPIA 7')).toBe('ARROZ DIANA');
  });

  it('es insensible a mayúsculas en el sufijo', () => {
    expect(stripCopySuffix('Arroz Diana copia 3')).toBe('Arroz Diana');
  });

  it('tolera espacios sobrantes alrededor y dentro del sufijo', () => {
    expect(stripCopySuffix('  ARROZ DIANA   COPIA   2  ')).toBe('ARROZ DIANA');
  });

  it('solo quita UN sufijo (el último): "X COPIA COPIA" → "X COPIA"', () => {
    expect(stripCopySuffix('ARROZ COPIA COPIA')).toBe('ARROZ COPIA');
  });

  it('NO mutila un producto que se llame literalmente "COPIA"', () => {
    expect(stripCopySuffix('COPIA')).toBe('COPIA');
  });

  it('un nombre que es SOLO el sufijo cae al nombre original (nunca vacío)', () => {
    // Un nombre vacío violaría el CHECK `chk_products_name_not_empty`.
    expect(stripCopySuffix(' COPIA 4')).toBe('COPIA 4');
  });

  it('no confunde COPIA con parte de otra palabra', () => {
    expect(stripCopySuffix('PAPEL FOTOCOPIA')).toBe('PAPEL FOTOCOPIA');
  });

  it('no quita un número suelto sin la palabra COPIA', () => {
    expect(stripCopySuffix('ARROZ DIANA 500')).toBe('ARROZ DIANA 500');
  });
});

describe('buildCopyName', () => {
  it('el primer intento va SIN número', () => {
    expect(buildCopyName('ARROZ DIANA', 1)).toBe(`ARROZ DIANA ${COPY_LABEL}`);
  });

  it('del segundo en adelante se numera', () => {
    expect(buildCopyName('ARROZ DIANA', 2)).toBe(`ARROZ DIANA ${COPY_LABEL} 2`);
    expect(buildCopyName('ARROZ DIANA', 15)).toBe(`ARROZ DIANA ${COPY_LABEL} 15`);
  });

  it('intento 0 o negativo se trata como el primero (defensivo)', () => {
    expect(buildCopyName('ARROZ DIANA', 0)).toBe(`ARROZ DIANA ${COPY_LABEL}`);
    expect(buildCopyName('ARROZ DIANA', -3)).toBe(`ARROZ DIANA ${COPY_LABEL}`);
  });
});

describe('resolveCopyName', () => {
  it('catálogo limpio → "<NOMBRE> COPIA"', async () => {
    const isTaken = takenFrom([]);
    await expect(resolveCopyName('ARROZ DIANA', isTaken)).resolves.toBe('ARROZ DIANA COPIA');
    expect(isTaken).toHaveBeenCalledTimes(1);
  });

  it('si "COPIA" está ocupado → "COPIA 2"', async () => {
    const isTaken = takenFrom(['ARROZ DIANA COPIA']);
    await expect(resolveCopyName('ARROZ DIANA', isTaken)).resolves.toBe('ARROZ DIANA COPIA 2');
  });

  it('numera en cadena saltando todos los ocupados', async () => {
    const isTaken = takenFrom(['ARROZ DIANA COPIA', 'ARROZ DIANA COPIA 2', 'ARROZ DIANA COPIA 3']);
    await expect(resolveCopyName('ARROZ DIANA', isTaken)).resolves.toBe('ARROZ DIANA COPIA 4');
  });

  it('rellena el HUECO más bajo, no continúa desde el máximo', async () => {
    const isTaken = takenFrom(['ARROZ DIANA COPIA', 'ARROZ DIANA COPIA 3']);
    await expect(resolveCopyName('ARROZ DIANA', isTaken)).resolves.toBe('ARROZ DIANA COPIA 2');
  });

  it('duplicar una copia NO encadena sufijos', async () => {
    const isTaken = takenFrom(['ARROZ DIANA', 'ARROZ DIANA COPIA']);
    await expect(resolveCopyName('ARROZ DIANA COPIA', isTaken)).resolves.toBe(
      'ARROZ DIANA COPIA 2',
    );
  });

  it('duplicar "COPIA 2" tampoco encadena: sigue numerando desde la raíz', async () => {
    const isTaken = takenFrom(['ARROZ DIANA', 'ARROZ DIANA COPIA', 'ARROZ DIANA COPIA 2']);
    await expect(resolveCopyName('ARROZ DIANA COPIA 2', isTaken)).resolves.toBe(
      'ARROZ DIANA COPIA 3',
    );
  });

  it('el match de ocupado ignora mayúsculas (el índice único del catálogo también)', async () => {
    const isTaken = takenFrom(['arroz diana copia']);
    await expect(resolveCopyName('ARROZ DIANA', isTaken)).resolves.toBe('ARROZ DIANA COPIA 2');
  });

  it('trimea el nombre de origen', async () => {
    const isTaken = takenFrom([]);
    await expect(resolveCopyName('   ARROZ DIANA   ', isTaken)).resolves.toBe('ARROZ DIANA COPIA');
  });

  it('lanza un error de dominio al agotar los intentos', async () => {
    const isTaken = alwaysTaken();
    await expect(resolveCopyName('ARROZ DIANA', isTaken, 3)).rejects.toThrow(
      /demasiadas copias de "ARROZ DIANA"/,
    );
    expect(isTaken).toHaveBeenCalledTimes(3);
  });

  it('el tope por defecto es MAX_COPY_ATTEMPTS', async () => {
    const isTaken = alwaysTaken();
    await expect(resolveCopyName('X', isTaken)).rejects.toThrow();
    expect(isTaken).toHaveBeenCalledTimes(MAX_COPY_ATTEMPTS);
  });

  it('propaga el error del predicado (fallo de BD) sin tragárselo', async () => {
    const isTaken = jest.fn(() => Promise.reject(new Error('conexión perdida')));
    await expect(resolveCopyName('ARROZ DIANA', isTaken)).rejects.toThrow('conexión perdida');
  });
});
