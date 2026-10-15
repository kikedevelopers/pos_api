import { toCategoryResponseDto } from '../dto/category-response.dto';
import type { Category } from '../entities/category.entity';

describe('toCategoryResponseDto', () => {
  const base = {
    id: '4',
    company_id: '13',
    name: 'Bebidas',
    is_archived: false,
    created_at: new Date('2026-10-15T00:00:00.000Z'),
    updated_at: new Date('2026-10-15T00:00:00.000Z'),
  };

  it('expone catalog_visible=false cuando la categoría está oculta', () => {
    const dto = toCategoryResponseDto({ ...base, catalog_visible: false } as Category);
    expect(dto.catalog_visible).toBe(false);
  });

  it('expone catalog_visible=true cuando está visible', () => {
    const dto = toCategoryResponseDto({ ...base, catalog_visible: true } as Category);
    expect(dto.catalog_visible).toBe(true);
  });

  it('una fila sin la columna (default) se trata como visible', () => {
    const dto = toCategoryResponseDto(base as unknown as Category);
    expect(dto.catalog_visible).toBe(true);
  });
});
