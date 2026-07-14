import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CreateBoardDto } from '../dto/kanban.dto';
import { KanbanBoard } from '../entities/kanban-board.entity';
import type { KanbanActor } from '../internal/kanban-actor';
import { rankAtEnd } from '../internal/kanban-ranking';
import {
  isUniqueViolation,
  lockCompanyBoards,
  maxBoardPosition,
} from '../internal/kanban-repository';

/** Crea un tablero al final de la tira. Atómico e idempotente por `client_operation_id`. */
@Injectable()
export class CreateBoardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(dto: CreateBoardDto, companyId: number, actor: KanbanActor): Promise<KanbanBoard> {
    return this.dataSource.transaction<KanbanBoard>(async (m) => {
      const opId = dto.client_operation_id ?? null;

      // Fast-path idempotente: si ya se creó con esta llave, devuélvelo.
      if (opId) {
        const existing = await m.findOne(KanbanBoard, {
          where: { company_id: String(companyId), client_operation_id: opId },
        });
        if (existing) return existing;
      }

      // Serializa la asignación de posición al final entre creaciones concurrentes.
      await lockCompanyBoards(m, companyId);
      const position = rankAtEnd(await maxBoardPosition(m, companyId));

      const board = m.create(KanbanBoard, {
        company_id: String(companyId),
        title: dto.title.trim(),
        position,
        created_by: actor.fullName || null,
        created_by_id: String(actor.id),
        client_operation_id: opId,
      });

      try {
        return await m.save(board);
      } catch (err) {
        // Carrera con la misma llave: recupera el ganador en vez de duplicar.
        if (opId && isUniqueViolation(err, 'uq_kanban_boards_client_operation')) {
          const winner = await m.findOne(KanbanBoard, {
            where: { company_id: String(companyId), client_operation_id: opId },
          });
          if (winner) return winner;
        }
        throw err;
      }
    });
  }
}
