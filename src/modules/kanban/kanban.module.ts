import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RealtimeModule } from '@/modules/realtime/realtime.module';

import { CreateBoardAction } from './actions/create-board.action';
import { CreateCardAction } from './actions/create-card.action';
import { CreateChecklistItemAction } from './actions/create-checklist-item.action';
import { DeleteBoardAction } from './actions/delete-board.action';
import { DeleteCardAction } from './actions/delete-card.action';
import { DeleteChecklistItemAction } from './actions/delete-checklist-item.action';
import { GetChecklistAction } from './actions/get-checklist.action';
import { GetKanbanAction } from './actions/get-kanban.action';
import { MoveBoardAction } from './actions/move-board.action';
import { MoveCardAction } from './actions/move-card.action';
import { UpdateBoardAction } from './actions/update-board.action';
import { UpdateCardAction } from './actions/update-card.action';
import { UpdateChecklistItemAction } from './actions/update-checklist-item.action';
import { KanbanBoard } from './entities/kanban-board.entity';
import { KanbanCard } from './entities/kanban-card.entity';
import { KanbanChecklistItem } from './entities/kanban-checklist-item.entity';
import { KanbanController } from './kanban.controller';
import { KanbanService } from './kanban.service';

/**
 * Módulo Kanban colaborativo — AISLADO. Ningún otro módulo lo importa, así que
 * desactivarlo/eliminarlo es quitar UNA línea (`KanbanModule`) del array
 * `imports` de `app.module.ts`. Importa `RealtimeModule` solo para emitir la
 * señal `kanban:changed`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([KanbanBoard, KanbanCard, KanbanChecklistItem]),
    RealtimeModule,
  ],
  controllers: [KanbanController],
  providers: [
    KanbanService,
    GetKanbanAction,
    CreateBoardAction,
    UpdateBoardAction,
    MoveBoardAction,
    DeleteBoardAction,
    CreateCardAction,
    UpdateCardAction,
    MoveCardAction,
    DeleteCardAction,
    GetChecklistAction,
    CreateChecklistItemAction,
    UpdateChecklistItemAction,
    DeleteChecklistItemAction,
  ],
})
export class KanbanModule {}
