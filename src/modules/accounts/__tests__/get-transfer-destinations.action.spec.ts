import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Bank } from '@/modules/banks/entities/bank.entity';
import { User } from '@/modules/users/entities/user.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import { GetTransferDestinationsAction } from '../actions/get-transfer-destinations.action';

/**
 * Tests de `GetTransferDestinationsAction` centrados en la sección multi-
 * sucursal "Negocio Principal":
 *
 *   - Company sucursal → agrega wallets/banks del principal con scope='main'.
 *   - Company principal → NO agrega sección main.
 *   - Sucursal sin principal resoluble → NO agrega sección main.
 *
 * Los destinos propios (scope='self') se cubren de forma implícita.
 */
describe('GetTransferDestinationsAction (sección Negocio Principal)', () => {
  let action: GetTransferDestinationsAction;

  // Datos por company: { walletsByCompany, banksByCompany }.
  let walletsByCompany: Map<string, Array<{ id: string; name: string; balance: number }>>;
  let banksByCompany: Map<string, Array<{ id: string; name: string; balance: number }>>;
  // Config multi-sucursal para el DataSource.query mock.
  let companies: Map<string, { name: string; is_branch: boolean }>;
  let mainByBranch: Map<string, { id: number; name: string }>;

  beforeEach(async () => {
    walletsByCompany = new Map();
    banksByCompany = new Map();
    companies = new Map();
    mainByBranch = new Map();

    const walletRepoMock = {
      find: jest.fn((opts: { where: { company_id: string } }) =>
        Promise.resolve(walletsByCompany.get(opts.where.company_id) ?? []),
      ),
    };
    const bankRepoMock = {
      find: jest.fn((opts: { where: { company_id: string } }) =>
        Promise.resolve(banksByCompany.get(opts.where.company_id) ?? []),
      ),
    };
    // El path source='bank' no consulta usuarios; igual dejamos un builder
    // encadenable por robustez si algún test usa source='wallet'.
    const qb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    const userRepoMock = {
      createQueryBuilder: jest.fn(() => qb),
    };
    const dataSourceMock = {
      query: jest.fn((sql: string, params: unknown[]) => {
        if (sql.includes('FROM companies WHERE id')) {
          const id = String(params[0]);
          const c = companies.get(id);
          return Promise.resolve(c ? [{ id, name: c.name, is_branch: c.is_branch }] : []);
        }
        if (sql.includes('company_members')) {
          const branchId = String(params[0]);
          const main = mainByBranch.get(branchId);
          return Promise.resolve(
            main ? [{ id: String(main.id), name: main.name, is_branch: false }] : [],
          );
        }
        return Promise.resolve([]);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetTransferDestinationsAction,
        { provide: getRepositoryToken(Wallet), useValue: walletRepoMock },
        { provide: getRepositoryToken(Bank), useValue: bankRepoMock },
        { provide: getRepositoryToken(User), useValue: userRepoMock },
        { provide: DataSource, useValue: dataSourceMock },
      ],
    }).compile();

    action = module.get(GetTransferDestinationsAction);
  });

  it('sucursal: agrega wallets y banks del principal con scope="main" y company_name', async () => {
    companies.set('100', { name: 'Sucursal Norte', is_branch: true });
    mainByBranch.set('100', { id: 1, name: 'Esencia & Granos' });
    banksByCompany.set('100', [{ id: '2', name: 'Banco Sucursal', balance: 10 }]);
    // Cuentas del principal.
    walletsByCompany.set('1', [{ id: '11', name: 'Efectivo Principal', balance: 500 }]);
    banksByCompany.set('1', [{ id: '12', name: 'Bancolombia Principal', balance: 900 }]);

    const { destinations } = await action.execute(100, 'bank', 2);

    const mainItems = destinations.filter((d) => d.scope === 'main');
    expect(mainItems).toHaveLength(2);
    expect(mainItems.every((d) => d.company_name === 'Esencia & Granos')).toBe(true);

    const mainWallet = mainItems.find((d) => d.type === 'wallet');
    const mainBank = mainItems.find((d) => d.type === 'bank');
    expect(mainWallet).toMatchObject({ id: 11, name: 'Efectivo Principal', balance: 500 });
    expect(mainBank).toMatchObject({ id: 12, name: 'Bancolombia Principal', balance: 900 });

    // Los propios llegan con scope='self' y sin company_name.
    const selfItems = destinations.filter((d) => d.scope === 'self');
    expect(selfItems.every((d) => d.company_name === undefined)).toBe(true);
  });

  it('negocio principal: NO agrega sección "Negocio Principal"', async () => {
    companies.set('1', { name: 'Esencia & Granos', is_branch: false });
    walletsByCompany.set('1', [{ id: '11', name: 'Efectivo', balance: 100 }]);
    banksByCompany.set('1', [{ id: '12', name: 'Banco', balance: 100 }]);

    const { destinations } = await action.execute(1, 'bank', 12);

    expect(destinations.some((d) => d.scope === 'main')).toBe(false);
  });

  it('sucursal sin principal resoluble: NO agrega sección main', async () => {
    companies.set('100', { name: 'Sucursal Norte', is_branch: true });
    // mainByBranch vacío → resolveMainCompanyForBranch devuelve null.
    banksByCompany.set('100', [{ id: '2', name: 'Banco Sucursal', balance: 10 }]);

    const { destinations } = await action.execute(100, 'bank', 99);

    expect(destinations.some((d) => d.scope === 'main')).toBe(false);
  });

  it('excluye la cuenta origen de la lista de destinos propios', async () => {
    companies.set('100', { name: 'Sucursal Norte', is_branch: true });
    mainByBranch.set('100', { id: 1, name: 'Principal' });
    banksByCompany.set('100', [
      { id: '2', name: 'Origen', balance: 10 },
      { id: '3', name: 'Otro Banco', balance: 20 },
    ]);

    const { destinations } = await action.execute(100, 'bank', 2);

    const selfBanks = destinations.filter((d) => d.scope === 'self' && d.type === 'bank');
    expect(selfBanks.map((d) => d.id)).toEqual([3]);
  });
});
