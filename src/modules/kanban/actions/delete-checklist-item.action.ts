import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { KanbanChecklistItem } from '../entities/kanban-checklist-item.entity';

/** Borra un ítem de checklist (scoped a la company). */
@Injectable()
export class DeleteChecklistItemAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(itemId: number, companyId: number): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const res = await m.delete(KanbanChecklistItem, {
        id: String(itemId),
        company_id: String(companyId),
      });
      if (!res.affected) throw new NotFoundException('Tarea no encontrada');
    });
  }
}
