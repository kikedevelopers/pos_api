import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MoveCardDto } from '../dto/kanban.dto';
import { KanbanBoard } from '../entities/kanban-board.entity';
import { KanbanCard } from '../entities/kanban-card.entity';
import { computeCardRank, lockBoardCards } from '../internal/kanban-repository';

/**
 * Mueve una tarjeta dentro de su tablero o a otro tablero, colocándola entre los
 * vecinos `before_id`/`after_id` del tablero destino. Atómico: lock por tablero
 * destino + un solo UPDATE de `board_id`+`position` (rank por punto medio).
 */
@Injectable()
export class MoveCardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(cardId: number, dto: MoveCardDto, companyId: number): Promise<KanbanCard> {
    return this.dataSource.transaction<KanbanCard>(async (m) => {
      const card = await m.findOne(KanbanCard, {
        where: { id: String(cardId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!card) throw new NotFoundException('Tarjeta no encontrada');

      // El tablero destino debe existir en la company (guard cross-tenant).
      const targetBoard = await m.findOne(KanbanBoard, {
        where: { id: String(dto.board_id), company_id: String(companyId) },
      });
      if (!targetBoard) throw new NotFoundException('Tablero destino no encontrado');

      // Serializa reordenamientos concurrentes del tablero destino.
      await lockBoardCards(m, dto.board_id);

      const position = await computeCardRank(
        m,
        companyId,
        dto.board_id,
        dto.before_id ?? null,
        dto.after_id ?? null,
      );

      card.board_id = String(dto.board_id);
      card.position = position;
      return m.save(card);
    });
  }
}
