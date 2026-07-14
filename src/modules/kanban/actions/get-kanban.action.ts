import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { KanbanStateDto, toKanbanState } from '../dto/kanban-response.dto';
import { loadKanban } from '../internal/kanban-repository';

/** Estado completo del kanban de la company (tableros + tarjetas, ordenados). */
@Injectable()
export class GetKanbanAction {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  execute(companyId: number): Promise<KanbanStateDto> {
    // Lectura consistente (ambas queries en la misma TX) — barata y evita ver un
    // estado a medias tras un movimiento concurrente.
    return this.dataSource.transaction(async (m) => {
      const { boards, cards } = await loadKanban(m, companyId);
      return toKanbanState(boards, cards);
    });
  }
}
