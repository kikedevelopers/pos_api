import { Injectable } from '@nestjs/common';

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
import type {
  CreateBoardDto,
  CreateCardDto,
  CreateChecklistItemDto,
  MoveBoardDto,
  MoveCardDto,
  UpdateBoardDto,
  UpdateCardDto,
  UpdateChecklistItemDto,
} from './dto/kanban.dto';
import type { ChecklistItemDto, KanbanStateDto } from './dto/kanban-response.dto';
import type { KanbanBoard } from './entities/kanban-board.entity';
import type { KanbanCard } from './entities/kanban-card.entity';
import type { KanbanChecklistItem } from './entities/kanban-checklist-item.entity';
import type { KanbanActor } from './internal/kanban-actor';

/**
 * Facade del módulo Kanban: sin lógica, solo delega a las actions (donde vive la
 * transacción atómica). Todo recibe `companyId` (del JWT) y lo propaga.
 */
@Injectable()
export class KanbanService {
  constructor(
    private readonly getKanbanAction: GetKanbanAction,
    private readonly createBoardAction: CreateBoardAction,
    private readonly updateBoardAction: UpdateBoardAction,
    private readonly moveBoardAction: MoveBoardAction,
    private readonly deleteBoardAction: DeleteBoardAction,
    private readonly createCardAction: CreateCardAction,
    private readonly updateCardAction: UpdateCardAction,
    private readonly moveCardAction: MoveCardAction,
    private readonly deleteCardAction: DeleteCardAction,
    private readonly getChecklistAction: GetChecklistAction,
    private readonly createChecklistItemAction: CreateChecklistItemAction,
    private readonly updateChecklistItemAction: UpdateChecklistItemAction,
    private readonly deleteChecklistItemAction: DeleteChecklistItemAction,
  ) {}

  getState(companyId: number): Promise<KanbanStateDto> {
    return this.getKanbanAction.execute(companyId);
  }

  createBoard(dto: CreateBoardDto, companyId: number, actor: KanbanActor): Promise<KanbanBoard> {
    return this.createBoardAction.execute(dto, companyId, actor);
  }

  updateBoard(boardId: number, dto: UpdateBoardDto, companyId: number): Promise<KanbanBoard> {
    return this.updateBoardAction.execute(boardId, dto, companyId);
  }

  moveBoard(boardId: number, dto: MoveBoardDto, companyId: number): Promise<KanbanBoard> {
    return this.moveBoardAction.execute(boardId, dto, companyId);
  }

  deleteBoard(boardId: number, companyId: number): Promise<void> {
    return this.deleteBoardAction.execute(boardId, companyId);
  }

  createCard(
    boardId: number,
    dto: CreateCardDto,
    companyId: number,
    actor: KanbanActor,
  ): Promise<KanbanCard> {
    return this.createCardAction.execute(boardId, dto, companyId, actor);
  }

  updateCard(cardId: number, dto: UpdateCardDto, companyId: number): Promise<KanbanCard> {
    return this.updateCardAction.execute(cardId, dto, companyId);
  }

  moveCard(cardId: number, dto: MoveCardDto, companyId: number): Promise<KanbanCard> {
    return this.moveCardAction.execute(cardId, dto, companyId);
  }

  deleteCard(cardId: number, companyId: number): Promise<void> {
    return this.deleteCardAction.execute(cardId, companyId);
  }

  getChecklist(cardId: number, companyId: number): Promise<ChecklistItemDto[]> {
    return this.getChecklistAction.execute(cardId, companyId);
  }

  createChecklistItem(
    cardId: number,
    dto: CreateChecklistItemDto,
    companyId: number,
  ): Promise<KanbanChecklistItem> {
    return this.createChecklistItemAction.execute(cardId, dto, companyId);
  }

  updateChecklistItem(
    itemId: number,
    dto: UpdateChecklistItemDto,
    companyId: number,
  ): Promise<KanbanChecklistItem> {
    return this.updateChecklistItemAction.execute(itemId, dto, companyId);
  }

  deleteChecklistItem(itemId: number, companyId: number): Promise<void> {
    return this.deleteChecklistItemAction.execute(itemId, companyId);
  }
}
