import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { BoardRow, CardRow, ChecklistItemRow } from '../internal/kanban-repository';
import type { KanbanBoard } from '../entities/kanban-board.entity';
import type { KanbanCard } from '../entities/kanban-card.entity';
import type { KanbanChecklistItem } from '../entities/kanban-checklist-item.entity';

/**
 * Shapes de respuesta del módulo Kanban. Los `id` (bigint en pg) se serializan
 * como `number` (los tableros/tarjetas no se acercan a MAX_SAFE_INTEGER), igual
 * que el resto del API. `position` se expone para que el cliente pueda ordenar
 * y calcular vecinos localmente.
 */
export class KanbanCardDto {
  @ApiProperty({ example: 12 }) id!: number;
  @ApiProperty({ example: 7 }) board_id!: number;
  @ApiProperty({ example: 'Llamar al proveedor' }) title!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ example: 1536 }) position!: number;
  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true }) created_by!: string | null;
  @ApiProperty({ example: '2026-07-13T14:28:00.000Z' }) created_at!: string;
  @ApiProperty({ example: 5, description: 'Total de ítems del checklist.' })
  checklist_total!: number;
  @ApiProperty({ example: 2, description: 'Ítems del checklist marcados como hechos.' })
  checklist_done!: number;
}

export class ChecklistItemDto {
  @ApiProperty({ example: 30 }) id!: number;
  @ApiProperty({ example: 12 }) card_id!: number;
  @ApiProperty({ example: 'Confirmar stock' }) text!: string;
  @ApiProperty({ example: false }) is_done!: boolean;
  @ApiProperty({ example: 1024 }) position!: number;
}

export class KanbanBoardDto {
  @ApiProperty({ example: 7 }) id!: number;
  @ApiProperty({ example: 'Pendiente' }) title!: string;
  @ApiProperty({ example: 1024 }) position!: number;
  @ApiPropertyOptional({ example: 'Kike Pacheco', nullable: true }) created_by!: string | null;
  @ApiProperty({ example: '2026-07-13T14:28:00.000Z' }) created_at!: string;
  @ApiProperty({ type: [KanbanCardDto] }) cards!: KanbanCardDto[];
}

export class KanbanStateDto {
  @ApiProperty({ type: [KanbanBoardDto] }) boards!: KanbanBoardDto[];
}

const cardRowToDto = (c: CardRow): KanbanCardDto => ({
  id: Number(c.id),
  board_id: Number(c.board_id),
  title: c.title,
  description: c.description,
  position: Number(c.position),
  created_by: c.created_by,
  created_at: new Date(c.created_at).toISOString(),
  checklist_total: Number(c.checklist_total),
  checklist_done: Number(c.checklist_done),
});

/** Ensambla el estado completo. `cards` viene ya ordenado por posición desde SQL. */
export const toKanbanState = (boards: BoardRow[], cards: CardRow[]): KanbanStateDto => {
  const byBoard = new Map<string, KanbanCardDto[]>();
  for (const c of cards) {
    const list = byBoard.get(c.board_id) ?? [];
    list.push(cardRowToDto(c));
    byBoard.set(c.board_id, list);
  }
  return {
    boards: boards.map((b) => ({
      id: Number(b.id),
      title: b.title,
      position: Number(b.position),
      created_by: b.created_by,
      created_at: new Date(b.created_at).toISOString(),
      cards: byBoard.get(b.id) ?? [],
    })),
  };
};

export const toBoardDto = (board: KanbanBoard, cards: KanbanCard[] = []): KanbanBoardDto => ({
  id: Number(board.id),
  title: board.title,
  position: Number(board.position),
  created_by: board.created_by,
  created_at: board.created_at.toISOString(),
  cards: cards.map(toCardDto),
});

/**
 * Card individual (respuesta de crear/editar/mover). Los contadores del checklist
 * van en 0: estas respuestas solo disparan el refetch de `GET /kanban` en el
 * cliente, que trae los contadores reales.
 */
export const toCardDto = (card: KanbanCard): KanbanCardDto => ({
  id: Number(card.id),
  board_id: Number(card.board_id),
  title: card.title,
  description: card.description,
  position: Number(card.position),
  created_by: card.created_by,
  created_at: card.created_at.toISOString(),
  checklist_total: 0,
  checklist_done: 0,
});

const checklistRowToDto = (r: ChecklistItemRow): ChecklistItemDto => ({
  id: Number(r.id),
  card_id: Number(r.card_id),
  text: r.text,
  is_done: r.is_done,
  position: Number(r.position),
});

export const toChecklist = (rows: ChecklistItemRow[]): ChecklistItemDto[] =>
  rows.map(checklistRowToDto);

export const toChecklistItemDto = (item: KanbanChecklistItem): ChecklistItemDto => ({
  id: Number(item.id),
  card_id: Number(item.card_id),
  text: item.text,
  is_done: item.is_done,
  position: Number(item.position),
});
