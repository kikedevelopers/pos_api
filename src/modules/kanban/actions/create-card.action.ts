import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CreateCardDto } from '../dto/kanban.dto';
import { KanbanBoard } from '../entities/kanban-board.entity';
import { KanbanCard } from '../entities/kanban-card.entity';
import type { KanbanActor } from '../internal/kanban-actor';
import { rankAtEnd } from '../internal/kanban-ranking';
import {
  isUniqueViolation,
  lockBoardCards,
  maxCardPosition,
} from '../internal/kanban-repository';

/** Crea una tarjeta al final de un tablero. Atómico e idempotente por `client_operation_id`. */
@Injectable()
export class CreateCardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    boardId: number,
    dto: CreateCardDto,
    companyId: number,
    actor: KanbanActor,
  ): Promise<KanbanCard> {
    return this.dataSource.transaction<KanbanCard>(async (m) => {
      const opId = dto.client_operation_id ?? null;

      if (opId) {
        const existing = await m.findOne(KanbanCard, {
          where: { company_id: String(companyId), client_operation_id: opId },
        });
        if (existing) return existing;
      }

      // El tablero debe existir en la company (guard cross-tenant).
      const board = await m.findOne(KanbanBoard, {
        where: { id: String(boardId), company_id: String(companyId) },
      });
      if (!board) throw new NotFoundException('Tablero no encontrado');

      await lockBoardCards(m, boardId);
      const position = rankAtEnd(await maxCardPosition(m, companyId, boardId));

      const card = m.create(KanbanCard, {
        company_id: String(companyId),
        board_id: String(boardId),
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        position,
        created_by: actor.fullName || null,
        created_by_id: String(actor.id),
        client_operation_id: opId,
      });

      try {
        return await m.save(card);
      } catch (err) {
        if (opId && isUniqueViolation(err, 'uq_kanban_cards_client_operation')) {
          const winner = await m.findOne(KanbanCard, {
            where: { company_id: String(companyId), client_operation_id: opId },
          });
          if (winner) return winner;
        }
        throw err;
      }
    });
  }
}
