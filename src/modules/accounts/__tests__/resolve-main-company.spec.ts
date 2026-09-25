import { getCompanyRef, resolveMainCompanyForBranch } from '../internal/resolve-main-company';

/**
 * Tests del helper de resolución multi-sucursal. Se mockea el `runner.query`
 * (DataSource | EntityManager) para verificar tanto el shape devuelto como
 * que los parámetros viajan como string (los ids son bigint en pg).
 */
describe('resolve-main-company helpers', () => {
  describe('getCompanyRef', () => {
    it('devuelve {id, name, is_branch} normalizados cuando la company existe', async () => {
      const query = jest.fn().mockResolvedValue([{ id: '42', name: 'Sucursal Norte', is_branch: true }]);
      const runner = { query } as unknown as Parameters<typeof getCompanyRef>[0];

      const ref = await getCompanyRef(runner, 42);

      expect(ref).toEqual({ id: 42, name: 'Sucursal Norte', is_branch: true });
      // El id viaja como string a la query parametrizada.
      expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM companies WHERE id'), ['42']);
    });

    it('devuelve null cuando la company no existe', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const runner = { query } as unknown as Parameters<typeof getCompanyRef>[0];

      await expect(getCompanyRef(runner, 999)).resolves.toBeNull();
    });

    it('coacciona is_branch a boolean estricto', async () => {
      const query = jest.fn().mockResolvedValue([{ id: '7', name: 'Principal', is_branch: false }]);
      const runner = { query } as unknown as Parameters<typeof getCompanyRef>[0];

      const ref = await getCompanyRef(runner, 7);
      expect(ref?.is_branch).toBe(false);
    });
  });

  describe('resolveMainCompanyForBranch', () => {
    it('devuelve el negocio principal del owner de la sucursal', async () => {
      const query = jest
        .fn()
        .mockResolvedValue([{ id: '1', name: 'Esencia & Granos', is_branch: false }]);
      const runner = { query } as unknown as Parameters<typeof resolveMainCompanyForBranch>[0];

      const main = await resolveMainCompanyForBranch(runner, 100);

      expect(main).toEqual({ id: 1, name: 'Esencia & Granos', is_branch: false });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('company_members'), ['100']);
    });

    it('devuelve null cuando la sucursal no tiene principal resoluble', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const runner = { query } as unknown as Parameters<typeof resolveMainCompanyForBranch>[0];

      await expect(resolveMainCompanyForBranch(runner, 100)).resolves.toBeNull();
    });

    it('la query filtra por is_branch = false (solo principal)', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const runner = { query } as unknown as Parameters<typeof resolveMainCompanyForBranch>[0];

      await resolveMainCompanyForBranch(runner, 5);
      const sql = query.mock.calls[0]?.[0] as string;
      expect(sql).toContain('is_branch = false');
      expect(sql).toContain("role = 'owner'");
    });
  });
});
