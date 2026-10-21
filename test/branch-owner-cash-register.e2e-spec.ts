import type { DataSource } from 'typeorm';

import { GetTransferDestinationsAction } from '@/modules/accounts/actions/get-transfer-destinations.action';
import { Bank } from '@/modules/banks/entities/bank.entity';
import { fetchCashAccounts } from '@/modules/dashboard/internal/cash-accounts';
import { ListTreasuryMovementsAction } from '@/modules/treasury/actions/list-treasury-movements.action';
import { User } from '@/modules/users/entities/user.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import {
  cleanupCompany,
  createDisposableBranch,
  createDisposableCompany,
  insertCompanyMember,
  insertOwnerUser,
  tryInitDataSource,
} from './helpers/e2e-db';

/**
 * Regresión (e2e, pos_db): caja del OWNER dentro de una SUCURSAL.
 *
 * El owner vive en el principal (`users.company_id = principal`) y entra a la
 * sucursal como `company_members`, pero su caja es de la sucursal
 * (`cash_registers.company_id = sucursal`). Los JOIN que exigían
 * `u.company_id = <sucursal>` la dejaban:
 *   - como "Sin asignar" en Tesorería → Cajas del negocio (y dashboard),
 *   - sin nombre en el feed de movimientos de Tesorería,
 *   - fuera de los destinos de traslado (Mover saldo).
 *
 * También fija que NO se cuelan cajas de otra company y que una caja sin
 * usuario sigue saliendo como "Sin asignar".
 *
 * Skip limpio si no hay BD. Companies desechables, cleanup total en afterAll.
 */

const PRINCIPAL = '__E2E_OWNER_CR_MAIN__';
const BRANCH = '__E2E_OWNER_CR_BRANCH__';
const OTHER = '__E2E_OWNER_CR_OTHER__';

describe('Caja del owner en sucursal (e2e, pos_db)', () => {
  let ds: DataSource | null = null;
  let principal_id = 0;
  let branch_id = 0;
  let other_id = 0;
  let owner_id = 0;
  let employee_id = 0;
  let outsider_id = 0;
  let owner_register_id = 0;
  let employee_register_id = 0;
  let orphan_register_id = 0;
  let branch_wallet_id = 0;

  type IdRow = { id: string };
  const db = (): DataSource => {
    if (!ds) {
      throw new Error('pos_db no inicializada');
    }
    return ds;
  };

  const insertUser = async (
    company_id: number,
    name: string,
    lastname: string,
    type: 'employee' | 'owner',
  ): Promise<number> => {
    const r = await db().query<IdRow[]>(
      `INSERT INTO users (name, lastname, email, password, type, company_id)
       VALUES ($1, $2, $3, 'x', $4, $5) RETURNING id`,
      [
        name,
        lastname,
        `__e2e_owner_cr_${name}_${Date.now()}@example.test`,
        type,
        String(company_id),
      ],
    );
    return parseInt(r[0]?.id ?? '0', 10);
  };

  const insertRegister = async (
    company_id: number,
    user_id: number | null,
    balance: number,
  ): Promise<number> => {
    const r = await db().query<IdRow[]>(
      `INSERT INTO cash_registers (company_id, user_id, balance) VALUES ($1, $2, $3) RETURNING id`,
      [String(company_id), user_id === null ? null : String(user_id), balance],
    );
    return parseInt(r[0]?.id ?? '0', 10);
  };

  const cleanupAll = async (): Promise<void> => {
    for (const name of [PRINCIPAL, BRANCH, OTHER]) {
      const rows = await db().query<IdRow[]>(`SELECT id FROM companies WHERE name = $1`, [name]);
      for (const row of rows) {
        const cid = String(row.id);
        // Tablas fuera de cleanupCompany, antes de borrar users/companies (FKs).
        await db().query(`DELETE FROM financial_movements WHERE company_id = $1`, [cid]);
        await db().query(`DELETE FROM cash_registers WHERE company_id = $1`, [cid]);
        await db().query(`DELETE FROM wallets WHERE company_id = $1`, [cid]);
      }
    }
    for (const name of [BRANCH, OTHER, PRINCIPAL]) {
      const rows = await db().query<IdRow[]>(`SELECT id FROM companies WHERE name = $1`, [name]);
      for (const row of rows) {
        await cleanupCompany(db(), parseInt(row.id, 10));
      }
    }
  };

  beforeAll(async () => {
    ds = await tryInitDataSource();
    if (!ds) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] pos_db no disponible — branch-owner-cash-register e2e SKIPPED.');
      return;
    }
    await cleanupAll();

    principal_id = await createDisposableCompany(ds, PRINCIPAL);
    branch_id = await createDisposableBranch(ds, BRANCH);
    other_id = await createDisposableCompany(ds, OTHER);

    // Owner: usuario del PRINCIPAL, miembro de la sucursal.
    owner_id = await insertOwnerUser(ds, principal_id, 'owner_cr');
    await insertCompanyMember(ds, owner_id, branch_id);
    // Empleado propio de la sucursal y usuario de un negocio ajeno.
    employee_id = await insertUser(branch_id, 'Angie', 'Bermudez', 'employee');
    outsider_id = await insertUser(other_id, 'Ajeno', 'Externo', 'employee');

    owner_register_id = await insertRegister(branch_id, owner_id, 1526700);
    employee_register_id = await insertRegister(branch_id, employee_id, 416150);
    orphan_register_id = await insertRegister(branch_id, null, 50);
    // El owner también tiene caja en el principal: NO debe aparecer en la sucursal.
    await insertRegister(principal_id, owner_id, 999);
    await insertRegister(other_id, outsider_id, 777);

    const w = await ds.query<IdRow[]>(
      `INSERT INTO wallets (company_id, name, balance) VALUES ($1, 'Efectivo', 1000) RETURNING id`,
      [String(branch_id)],
    );
    branch_wallet_id = parseInt(w[0]?.id ?? '0', 10);
  });

  afterAll(async () => {
    if (!ds) {
      return;
    }
    await cleanupAll();
    await ds.destroy();
  });

  it('Cajas del negocio: la caja del owner en la sucursal lleva su nombre (no "Sin asignar")', async () => {
    if (!ds) {
      return;
    }
    const result = await fetchCashAccounts(ds, branch_id);

    const owner_register = result.cashRegisters.find((r) => r.id === owner_register_id);
    expect(owner_register).toEqual({
      id: owner_register_id,
      userName: 'E2E Owner',
      balance: 1526700,
    });
    const employee_register = result.cashRegisters.find((r) => r.id === employee_register_id);
    expect(employee_register?.userName).toBe('Angie Bermudez');
  });

  it('Cajas del negocio: una caja sin usuario sigue saliendo como "Sin asignar"', async () => {
    if (!ds) {
      return;
    }
    const result = await fetchCashAccounts(ds, branch_id);

    const orphan = result.cashRegisters.find((r) => r.id === orphan_register_id);
    expect(orphan?.userName).toBe('Sin asignar');
    expect(result.cashRegisters.filter((r) => r.userName === 'Sin asignar')).toHaveLength(1);
  });

  it('Cajas del negocio: solo cajas de la sucursal y totales al centavo', async () => {
    if (!ds) {
      return;
    }
    const result = await fetchCashAccounts(ds, branch_id);

    expect(result.cashRegisters.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      [owner_register_id, employee_register_id, orphan_register_id].sort((a, b) => a - b),
    );
    expect(result.totals.cashRegisters).toBe(1942900);
    expect(result.totals.wallets).toBe(1000);
    expect(result.totals.grand).toBe(1943900);
  });

  it('Feed de Tesorería: el movimiento hacia la caja del owner muestra su nombre', async () => {
    if (!ds) {
      return;
    }
    await ds.query(
      `INSERT INTO financial_movements
         (company_id, amount, movement_type, concept, description, source_type, source_id,
          destination_type, destination_id, reference_code, created_by)
       VALUES ($1, 100, 'INCOME', 'TRANSFER', 'e2e', 'wallet', $2, 'cash_register', $3, 'E2E-OWNER-CR', 'E2E')`,
      [String(branch_id), String(branch_wallet_id), String(owner_register_id)],
    );

    const movements = await new ListTreasuryMovementsAction(ds).execute(branch_id);

    const movement = movements.find((m) => m.reference_code === 'E2E-OWNER-CR');
    expect(movement?.source_name).toBe('Efectivo');
    expect(movement?.destination_name).toBe('E2E Owner');
  });

  it('Mover saldo: la caja del owner y la del empleado son destinos; nunca usuarios ajenos', async () => {
    if (!ds) {
      return;
    }
    const action = new GetTransferDestinationsAction(
      ds.getRepository(Wallet),
      ds.getRepository(Bank),
      ds.getRepository(User),
      ds,
    );

    const { destinations } = await action.execute(branch_id, 'wallet', branch_wallet_id);

    const users = destinations.filter((d) => d.type === 'user');
    expect(users).toEqual(
      expect.arrayContaining([
        { id: owner_id, name: 'E2E Owner', balance: 1526700, type: 'user', scope: 'self' },
        { id: employee_id, name: 'Angie Bermudez', balance: 416150, type: 'user', scope: 'self' },
      ]),
    );
    expect(users).toHaveLength(2);
    expect(users.some((d) => d.id === outsider_id)).toBe(false);
    // El saldo es el de la caja de la SUCURSAL, no el de su caja en el principal.
    expect(users.find((d) => d.id === owner_id)?.balance).not.toBe(999);
  });
});
