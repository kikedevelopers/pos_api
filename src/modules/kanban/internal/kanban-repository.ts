import { UnprocessableEntityException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { rankBetween, rebalancedPositions } from './kanban-ranking';

/** ¿El error es una violación del índice único parcial `constraint` (idempotencia)? */
export const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  const e = err as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = e?.code ?? e?.driverError?.code;
  const c = e?.constraint ?? e?.driverError?.constraint;
  return code === '23505' && c === constraint;
};

/**
 * Acceso a datos del Kanban con SQL DIRECTO parametrizado. Todas las funciones
 * reciben el `EntityManager` de una transacción y el `companyId` (del JWT), y
 * SIEMPRE filtran por `company_id` (guard cross-tenant efectivo del repo).
 */

// ─── Locks lógicos (se liberan solos al commit/rollback) ─────────────────────

/** Serializa reordenamientos concurrentes de tarjetas dentro del mismo tablero. */
export const lockBoardCards = (m: EntityManager, boardId: number | string): Promise<unknown> =>
  m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`kanban_board_${boardId}`]);

/** Serializa reordenamientos concurrentes de la tira de tableros de una company. */
export const lockCompanyBoards = (m: EntityManager, companyId: number | string): Promise<unknown> =>
  m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`kanban_boards_${companyId}`]);

// ─── Lecturas ────────────────────────────────────────────────────────────────

export type BoardRow = {
  id: string;
  title: string;
  position: number;
  created_by: string | null;
  created_at: string | Date;
};
export type CardRow = {
  id: string;
  board_id: string;
  title: string;
  description: string | null;
  position: number;
  created_by: string | null;
  created_at: string | Date;
  checklist_total: number;
  checklist_done: number;
};

/** Carga TODO el kanban de la company, ya ordenado por índice (2 queries). */
export const loadKanban = async (
  m: EntityManager,
  companyId: number,
): Promise<{ boards: BoardRow[]; cards: CardRow[] }> => {
  const boards: BoardRow[] = await m.query(
    `SELECT id, title, position, created_by, created_at
       FROM kanban_boards
      WHERE company_id = $1
      ORDER BY position ASC, id ASC`,
    [String(companyId)],
  );
  // Cada tarjeta trae el resumen del checklist (total y hechos) por LEFT JOIN
  // agregado — barato con el índice (company_id, card_id).
  const cards: CardRow[] = await m.query(
    `SELECT c.id, c.board_id, c.title, c.description, c.position, c.created_by, c.created_at,
            COALESCE(ci.total, 0)::int AS checklist_total,
            COALESCE(ci.done, 0)::int  AS checklist_done
       FROM kanban_cards c
       LEFT JOIN (
         SELECT card_id,
                count(*) AS total,
                count(*) FILTER (WHERE is_done) AS done
           FROM kanban_checklist_items
          WHERE company_id = $1
          GROUP BY card_id
       ) ci ON ci.card_id = c.id
      WHERE c.company_id = $1
      ORDER BY c.position ASC, c.id ASC`,
    [String(companyId)],
  );
  return { boards, cards };
};

// ─── Checklist ───────────────────────────────────────────────────────────────

export type ChecklistItemRow = {
  id: string;
  card_id: string;
  text: string;
  is_done: boolean;
  position: number;
};

/** Serializa altas/reordenamientos concurrentes del checklist de una tarjeta. */
export const lockCardChecklist = (m: EntityManager, cardId: number | string): Promise<unknown> =>
  m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`kanban_checklist_${cardId}`]);

/** ¿La tarjeta existe en la company? (guard cross-tenant antes de tocar su checklist). */
export const cardExistsInCompany = async (
  m: EntityManager,
  companyId: number,
  cardId: number,
): Promise<boolean> => {
  const rows: Array<{ one: number }> = await m.query(
    `SELECT 1 AS one FROM kanban_cards WHERE id = $1 AND company_id = $2`,
    [String(cardId), String(companyId)],
  );
  return rows.length > 0;
};

/** Ítems del checklist de una tarjeta, ordenados. */
export const loadChecklist = (
  m: EntityManager,
  companyId: number,
  cardId: number,
): Promise<ChecklistItemRow[]> =>
  m.query(
    `SELECT id, card_id, text, is_done, position
       FROM kanban_checklist_items
      WHERE company_id = $1 AND card_id = $2
      ORDER BY position ASC, id ASC`,
    [String(companyId), String(cardId)],
  );

/** Máxima posición de ítem dentro de una tarjeta (null si no hay). */
export const maxChecklistPosition = async (
  m: EntityManager,
  companyId: number,
  cardId: number,
): Promise<number | null> => {
  const rows: Array<{ max: number | null }> = await m.query(
    `SELECT max(position) AS max FROM kanban_checklist_items WHERE company_id = $1 AND card_id = $2`,
    [String(companyId), String(cardId)],
  );
  return rows[0]?.max === null || rows[0]?.max === undefined ? null : Number(rows[0].max);
};

/** Posición de un tablero (o null si no existe en la company). */
export const boardPosition = async (
  m: EntityManager,
  companyId: number,
  boardId: number,
): Promise<number | null> => {
  const rows: Array<{ position: number }> = await m.query(
    `SELECT position FROM kanban_boards WHERE id = $1 AND company_id = $2`,
    [String(boardId), String(companyId)],
  );
  return rows.length ? Number(rows[0].position) : null;
};

/** Posición de una tarjeta DENTRO de un tablero (null si no existe ahí). */
export const cardPosition = async (
  m: EntityManager,
  companyId: number,
  boardId: number,
  cardId: number,
): Promise<number | null> => {
  const rows: Array<{ position: number }> = await m.query(
    `SELECT position FROM kanban_cards WHERE id = $1 AND company_id = $2 AND board_id = $3`,
    [String(cardId), String(companyId), String(boardId)],
  );
  return rows.length ? Number(rows[0].position) : null;
};

/** Máxima posición de tablero de la company (null si no hay). */
export const maxBoardPosition = async (
  m: EntityManager,
  companyId: number,
): Promise<number | null> => {
  const rows: Array<{ max: number | null }> = await m.query(
    `SELECT max(position) AS max FROM kanban_boards WHERE company_id = $1`,
    [String(companyId)],
  );
  return rows[0]?.max === null || rows[0]?.max === undefined ? null : Number(rows[0].max);
};

/** Máxima posición de tarjeta dentro de un tablero (null si no hay). */
export const maxCardPosition = async (
  m: EntityManager,
  companyId: number,
  boardId: number,
): Promise<number | null> => {
  const rows: Array<{ max: number | null }> = await m.query(
    `SELECT max(position) AS max FROM kanban_cards WHERE company_id = $1 AND board_id = $2`,
    [String(companyId), String(boardId)],
  );
  return rows[0]?.max === null || rows[0]?.max === undefined ? null : Number(rows[0].max);
};

// ─── Rebalanceos (ruta rara: hueco de rank agotado) ──────────────────────────

/** Renumera por STEP todas las tarjetas de un tablero, respetando el orden actual. */
export const rebalanceCards = async (
  m: EntityManager,
  companyId: number,
  boardId: number,
): Promise<void> => {
  const rows: Array<{ id: string }> = await m.query(
    `SELECT id FROM kanban_cards
      WHERE company_id = $1 AND board_id = $2
      ORDER BY position ASC, id ASC`,
    [String(companyId), String(boardId)],
  );
  const positions = rebalancedPositions(rows.length);
  for (let i = 0; i < rows.length; i++) {
    await m.query(`UPDATE kanban_cards SET position = $1 WHERE id = $2`, [positions[i], rows[i].id]);
  }
};

/** Renumera por STEP la tira de tableros de la company. */
export const rebalanceBoards = async (m: EntityManager, companyId: number): Promise<void> => {
  const rows: Array<{ id: string }> = await m.query(
    `SELECT id FROM kanban_boards WHERE company_id = $1 ORDER BY position ASC, id ASC`,
    [String(companyId)],
  );
  const positions = rebalancedPositions(rows.length);
  for (let i = 0; i < rows.length; i++) {
    await m.query(`UPDATE kanban_boards SET position = $1 WHERE id = $2`, [positions[i], rows[i].id]);
  }
};

// ─── Cálculo de rank objetivo entre dos vecinos (con rebalanceo si hace falta) ─

/**
 * Rank para una tarjeta que cae entre `beforeId` (encima) y `afterId` (debajo)
 * DENTRO de `boardId`. Los vecinos deben existir en ese tablero (si el cliente
 * envía un vecino obsoleto → 422 para forzar refetch). Si el hueco se agota,
 * rebalancea el tablero y recalcula.
 */
export const computeCardRank = async (
  m: EntityManager,
  companyId: number,
  boardId: number,
  beforeId: number | null,
  afterId: number | null,
): Promise<number> => {
  const readNeighbor = async (id: number | null): Promise<number | null> => {
    if (id === null) return null;
    const pos = await cardPosition(m, companyId, boardId, id);
    if (pos === null) {
      throw new UnprocessableEntityException(
        'La posición de destino cambió; recarga el tablero e inténtalo de nuevo.',
      );
    }
    return pos;
  };

  const prev = await readNeighbor(beforeId);
  const next = await readNeighbor(afterId);
  const rank = rankBetween(prev, next);
  if (rank !== null) return rank;

  await rebalanceCards(m, companyId, boardId);
  const prev2 = await readNeighbor(beforeId);
  const next2 = await readNeighbor(afterId);
  const rank2 = rankBetween(prev2, next2);
  // Tras rebalancear el hueco es RANK_STEP; el punto medio siempre existe.
  return rank2 as number;
};

/** Rank para un tablero que cae entre `beforeId` (izquierda) y `afterId` (derecha). */
export const computeBoardRank = async (
  m: EntityManager,
  companyId: number,
  beforeId: number | null,
  afterId: number | null,
): Promise<number> => {
  const readNeighbor = async (id: number | null): Promise<number | null> => {
    if (id === null) return null;
    const pos = await boardPosition(m, companyId, id);
    if (pos === null) {
      throw new UnprocessableEntityException(
        'La posición de destino cambió; recarga el tablero e inténtalo de nuevo.',
      );
    }
    return pos;
  };

  const prev = await readNeighbor(beforeId);
  const next = await readNeighbor(afterId);
  const rank = rankBetween(prev, next);
  if (rank !== null) return rank;

  await rebalanceBoards(m, companyId);
  const prev2 = await readNeighbor(beforeId);
  const next2 = await readNeighbor(afterId);
  return rankBetween(prev2, next2) as number;
};
