import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MoveBoardDto } from '../dto/kanban.dto';
import { KanbanBoard } from '../entities/kanban-board.entity';
import { computeBoardRank, lockCompanyBoards } from '../internal/kanban-repository';

/** Reordena un tablero en la tira horizontal. Atómico: un solo UPDATE de rank. */
@Injectable()
export class MoveBoardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(boardId: number, dto: MoveBoardDto, companyId: number): Promise<KanbanBoard> {
    return this.dataSource.transaction<KanbanBoard>(async (m) => {
      // Serializa reordenamientos concurrentes de la tira de tableros.
      await lockCompanyBoards(m, companyId);

      const board = await m.findOne(KanbanBoard, {
        where: { id: String(boardId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!board) throw new NotFoundException('Tablero no encontrado');

      board.position = await computeBoardRank(
        m,
        companyId,
        dto.before_id ?? null,
        dto.after_id ?? null,
      );
      return m.save(board);
    });
  }
}
