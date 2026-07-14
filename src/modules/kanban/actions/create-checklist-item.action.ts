import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CreateChecklistItemDto } from '../dto/kanban.dto';
import { KanbanChecklistItem } from '../entities/kanban-checklist-item.entity';
import { rankAtEnd } from '../internal/kanban-ranking';
import {
  cardExistsInCompany,
  lockCardChecklist,
  maxChecklistPosition,
} from '../internal/kanban-repository';

/** Crea un ítem de checklist al final de la lista de una tarjeta. Atómico. */
@Injectable()
export class CreateChecklistItemAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(
    cardId: number,
    dto: CreateChecklistItemDto,
    companyId: number,
  ): Promise<KanbanChecklistItem> {
    return this.dataSource.transaction<KanbanChecklistItem>(async (m) => {
      if (!(await cardExistsInCompany(m, companyId, cardId))) {
        throw new NotFoundException('Tarjeta no encontrada');
      }
      await lockCardChecklist(m, cardId);
      const position = rankAtEnd(await maxChecklistPosition(m, companyId, cardId));

      const item = m.create(KanbanChecklistItem, {
        company_id: String(companyId),
        card_id: String(cardId),
        text: dto.text.trim(),
        is_done: false,
        position,
      });
      return m.save(item);
    });
  }
}
