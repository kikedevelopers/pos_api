import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { UpdateCardDto } from '../dto/kanban.dto';
import { KanbanCard } from '../entities/kanban-card.entity';

/** Edita el contenido de una tarjeta (título/descripción). Scoped a la company. */
@Injectable()
export class UpdateCardAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(cardId: number, dto: UpdateCardDto, companyId: number): Promise<KanbanCard> {
    return this.dataSource.transaction<KanbanCard>(async (m) => {
      const card = await m.findOne(KanbanCard, {
        where: { id: String(cardId), company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!card) throw new NotFoundException('Tarjeta no encontrada');

      if (dto.title !== undefined) card.title = dto.title.trim();
      if (dto.description !== undefined) card.description = dto.description?.trim() || null;
      return m.save(card);
    });
  }
}
