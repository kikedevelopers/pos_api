import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { KanbanCard } from '../entities/kanban-card.entity';

/** Borra una tarjeta (scoped a la company). */
@Injectable()
export class DeleteCardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(cardId: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const res = await m.delete(KanbanCard, {
        id: String(cardId),
        company_id: String(companyId),
      });
      if (!res.affected) throw new NotFoundException('Tarjeta no encontrada');
    });
  }
}
