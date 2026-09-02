import { buildImageObjectName, isObjectOwnedByCompany } from '../image-object-name';

/**
 * La ruta del objeto es lo único que se persiste, así que su forma es contrato:
 * carpeta por company (aislamiento visible en el bucket), id del producto al
 * frente (buscable a ojo) y sufijo aleatorio (invalida el caché del navegador
 * al reemplazar la foto).
 */
describe('buildImageObjectName', () => {
  const base = { prefix: 'inventory_items', companyId: 8, productId: 42, extension: 'jpg' };

  it('arma la ruta con carpeta por company e id del producto al frente', () => {
    expect(buildImageObjectName(base)).toMatch(/^inventory_items\/8\/42-[0-9a-f]{16}\.jpg$/);
  });

  it('dos llamadas seguidas NUNCA producen la misma ruta', () => {
    // Es lo que impide que el navegador sirva la imagen vieja desde su caché
    // cuando el usuario reemplaza la foto.
    const names = new Set(Array.from({ length: 50 }, () => buildImageObjectName(base)));
    expect(names.size).toBe(50);
  });

  it('respeta la extensión del formato detectado', () => {
    expect(buildImageObjectName({ ...base, extension: 'webp' })).toMatch(/\.webp$/);
    expect(buildImageObjectName({ ...base, extension: 'png' })).toMatch(/\.png$/);
  });

  it('normaliza el prefijo con barras sobrantes', () => {
    expect(buildImageObjectName({ ...base, prefix: '/inventory_items/' })).toMatch(
      /^inventory_items\/8\/42-/,
    );
  });

  it('cada company tiene su propia carpeta', () => {
    expect(buildImageObjectName({ ...base, companyId: 11 })).toMatch(/^inventory_items\/11\//);
  });
});

describe('isObjectOwnedByCompany', () => {
  it('acepta una ruta de la carpeta de la company', () => {
    expect(isObjectOwnedByCompany('inventory_items/8/42-abc.jpg', 'inventory_items', 8)).toBe(true);
  });

  it('rechaza la ruta de OTRA company (borrarla tocaría un archivo ajeno)', () => {
    expect(isObjectOwnedByCompany('inventory_items/9/42-abc.jpg', 'inventory_items', 8)).toBe(
      false,
    );
  });

  it('rechaza una company cuyo id es prefijo de otra (8 vs 81)', () => {
    expect(isObjectOwnedByCompany('inventory_items/81/42-abc.jpg', 'inventory_items', 8)).toBe(
      false,
    );
  });

  it('rechaza una ruta de otra carpeta del bucket (respaldos)', () => {
    expect(isObjectOwnedByCompany('backups/8/dump.sql', 'inventory_items', 8)).toBe(false);
  });

  it('rechaza un intento de salir de la carpeta por la ruta', () => {
    expect(isObjectOwnedByCompany('../backups/8/dump.sql', 'inventory_items', 8)).toBe(false);
  });

  it('normaliza el prefijo con barras sobrantes', () => {
    expect(isObjectOwnedByCompany('inventory_items/8/42-abc.jpg', '/inventory_items/', 8)).toBe(
      true,
    );
  });
});
