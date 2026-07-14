import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { UpdateChecklistItemDto } from '../dto/kanban.dto';
import { KanbanChecklistItem } from '../entities/kanban-checklist-item.entity';

/** Edita un ítem de checklist (texto y/o marcado). Scoped a la company. */
@Injectable()
export class UpdateChecklistItemAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    itemId: number,
    dto: UpdateChecklistItemDto,
    companyId: number,
  ): Promise<KanbanChecklistItem> {
    return this.dataSource.transaction<KanbanChecklistItem>(async (m) => {
      const item = await m.findOne(KanbanChecklistItem, {
        where: { id: String(itemId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!item) throw new NotFoundException('Tarea no encontrada');

      if (dto.text !== undefined) item.text = dto.text.trim();
      if (dto.is_done !== undefined) item.is_done = dto.is_done;
      return m.save(item);
    });
  }
}
