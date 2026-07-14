import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { UpdateBoardDto } from '../dto/kanban.dto';
import { KanbanBoard } from '../entities/kanban-board.entity';

/** Renombra un tablero (scoped a la company). */
@Injectable()
export class UpdateBoardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(boardId: number, dto: UpdateBoardDto, companyId: number): Promise<KanbanBoard> {
    return this.dataSource.transaction<KanbanBoard>(async (m) => {
      const board = await m.findOne(KanbanBoard, {
        where: { id: String(boardId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!board) throw new NotFoundException('Tablero no encontrado');
      board.title = dto.title.trim();
      return m.save(board);
    });
  }
}
