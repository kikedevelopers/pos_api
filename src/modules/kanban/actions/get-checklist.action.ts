import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ChecklistItemDto, toChecklist } from '../dto/kanban-response.dto';
import { cardExistsInCompany, loadChecklist } from '../internal/kanban-repository';

/** Checklist (ordenado) de una tarjeta de la company. */
@Injectable()
export class GetChecklistAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  execute(cardId: number, companyId: number): Promise<ChecklistItemDto[]> {
    return this.dataSource.transaction(async (m) => {
      if (!(await cardExistsInCompany(m, companyId, cardId))) {
        throw new NotFoundException('Tarjeta no encontrada');
      }
      return toChecklist(await loadChecklist(m, companyId, cardId));
    });
  }
}
