import type { DataSource } from 'typeorm';

import { preciseNumber } from '@/common/utils/precision';

/**
 * Snapshot patrimonial del negocio (cajas, bancos y billeteras) usado por
 * `GET /dashboard/today` — sección `cashAccounts`.
 *
 * Espejo PlacePos `fetchCashAccounts` (`dashboard.routes.ts:685`):
 *   - `cash_registers`: balance por caja registradora (con nombre del usuario).
 *   - `banks`: solo no archivados, balance y account_number.
 *   - `wallets`: solo no archivados.
 *   - `totals`: suma por categoría + grand total.
 *
 * Multi-tenant: las tres queries filtran por `company_id = $1`. Las
 * categorías son disjuntas — no hay JOIN cross-tenant posible.
 */

interface CashRegisterRow {
  id: string;
  user_name: string | null;
  balance: number;
}

interface BankRow {
  id: string;
  name: string;
  account_number: string;
  balance: number;
}

interface WalletRow {
  id: string;
  name: string;
  balance: number;
}

export interface CashAccountsResult {
  cashRegisters: { id: number; userName: string; balance: number }[];
  banks: { id: number; name: string; accountNumber: string; balance: number }[];
  wallets: { id: number; name: string; balance: number }[];
  totals: { cashRegisters: number; banks: number; wallets: number; grand: number };
}

const round2 = (n: unknown): number => preciseNumber(n, 2);

export async function fetchCashAccounts(
  dataSource: DataSource,
  companyId: number,
): Promise<CashAccountsResult> {
  const cid = String(companyId);

  const [registers, banks, wallets] = await Promise.all([
    dataSource.query<CashRegisterRow[]>(
      `
      SELECT
        cr.id::text AS id,
        NULLIF(TRIM(BOTH FROM CONCAT_WS(' ', u.name, u.lastname)), '') AS user_name,
        cr.balance::float AS balance
      FROM cash_registers cr
      LEFT JOIN users u
        ON u.id = cr.user_id
       AND u.company_id = $1
      WHERE cr.company_id = $1
      ORDER BY user_name NULLS LAST, cr.id ASC
      `,
      [cid],
    ),
    dataSource.query<BankRow[]>(
      `
      SELECT
        b.id::text AS id,
        b.name AS name,
        b.account_number AS account_number,
        b.balance::float AS balance
      FROM banks b
      WHERE b.company_id = $1
        AND b.is_archived = false
      ORDER BY b.name ASC
      `,
      [cid],
    ),
    dataSource.query<WalletRow[]>(
      `
      SELECT
        w.id::text AS id,
        w.name AS name,
        w.balance::float AS balance
      FROM wallets w
      WHERE w.company_id = $1
        AND w.is_archived = false
      ORDER BY w.name ASC
      `,
      [cid],
    ),
  ]);

  const cashRegisters = registers.map((r) => ({
    id: Number(r.id),
    userName: r.user_name?.trim() || 'Sin asignar',
    balance: round2(r.balance),
  }));
  const banksOut = banks.map((b) => ({
    id: Number(b.id),
    name: b.name,
    accountNumber: b.account_number,
    balance: round2(b.balance),
  }));
  const walletsOut = wallets.map((w) => ({
    id: Number(w.id),
    name: w.name,
    balance: round2(w.balance),
  }));

  const sum = (arr: { balance: number }[]): number =>
    round2(arr.reduce((acc, a) => acc + a.balance, 0));
  const totals = {
    cashRegisters: sum(cashRegisters),
    banks: sum(banksOut),
    wallets: sum(walletsOut),
    grand: round2(sum(cashRegisters) + sum(banksOut) + sum(walletsOut)),
  };

  return { cashRegisters, banks: banksOut, wallets: walletsOut, totals };
}
