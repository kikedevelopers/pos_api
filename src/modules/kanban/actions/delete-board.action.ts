import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { KanbanBoard } from '../entities/kanban-board.entity';

/** Borra un tablero y sus tarjetas (FK ON DELETE CASCADE). Scoped a la company. */
@Injectable()
export class DeleteBoardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(boardId: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const res = await m.delete(KanbanBoard, {
        id: String(boardId),
        company_id: String(companyId),
      });
      if (!res.affected) throw new NotFoundException('Tablero no encontrado');
    });
  }
}
