import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentCompany } from '@/common/decorators/current-company.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import type { AuthUser } from '@/common/types/jwt-payload.type';
import { RealtimeGateway } from '@/modules/realtime/realtime.gateway';

import type { KanbanActor } from './internal/kanban-actor';

import {
  CreateBoardDto,
  CreateCardDto,
  CreateChecklistItemDto,
  MoveBoardDto,
  MoveCardDto,
  UpdateBoardDto,
  UpdateCardDto,
  UpdateChecklistItemDto,
} from './dto/kanban.dto';
import {
  ChecklistItemDto,
  KanbanBoardDto,
  KanbanCardDto,
  KanbanStateDto,
  toBoardDto,
  toCardDto,
  toChecklistItemDto,
} from './dto/kanban-response.dto';
import { KanbanService } from './kanban.service';

/**
 * Kanban colaborativo (módulo AISLADO). Compartido por toda la company; cualquier
 * rol autenticado participa (`@Roles('owner','manager','employee')`). El
 * `company_id` SIEMPRE sale de `@CurrentCompany()` (JWT), nunca del cliente.
 *
 * Tras cada mutación se emite `kanban:changed` (best-effort) para que los demás
 * participantes refetcheen `GET /kanban`.
 */
@ApiTags('kanban')
@Controller('kanban')
export class KanbanController {
  private readonly logger = new Logger(KanbanController.name);

  constructor(
    private readonly kanbanService: KanbanService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Actor de la operación (autoría) derivado del JWT. */
  private actorOf(user: AuthUser): KanbanActor {
    return { id: user.user_id, fullName: `${user.name} ${user.lastname}`.trim() };
  }

  /** Emisión best-effort: un fallo de socket nunca rompe la mutación. */
  private notify(companyId: number, payload: { boardId?: number; cardId?: number } = {}): void {
    try {
      this.realtime.emitKanbanChanged(companyId, payload);
    } catch (err) {
      this.logger.warn(`No se pudo emitir kanban:changed (${String(err)})`);
    }
  }

  // ─── Estado completo ────────────────────────────────────────────────────────

  @Get()
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Estado completo del Kanban (tableros + tarjetas, ordenados).' })
  getState(@CurrentCompany() companyId: number): Promise<KanbanStateDto> {
    return this.kanbanService.getState(companyId);
  }

  // ─── Tableros ─────────────────────────────────────────────────────────────

  @Post('boards')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Crear un tablero al final de la tira.' })
  async createBoard(
    @Body() dto: CreateBoardDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<KanbanBoardDto> {
    const board = await this.kanbanService.createBoard(dto, companyId, this.actorOf(user));
    this.notify(companyId, { boardId: Number(board.id) });
    return toBoardDto(board);
  }

  @Patch('boards/:id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Renombrar un tablero.' })
  async updateBoard(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBoardDto,
    @CurrentCompany() companyId: number,
  ): Promise<KanbanBoardDto> {
    const board = await this.kanbanService.updateBoard(id, dto, companyId);
    this.notify(companyId, { boardId: id });
    return toBoardDto(board);
  }

  @Patch('boards/:id/move')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Reordenar un tablero (entre before_id y after_id).' })
  async moveBoard(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MoveBoardDto,
    @CurrentCompany() companyId: number,
  ): Promise<KanbanBoardDto> {
    const board = await this.kanbanService.moveBoard(id, dto, companyId);
    this.notify(companyId, { boardId: id });
    return toBoardDto(board);
  }

  @Delete('boards/:id')
  @Roles('owner', 'manager', 'employee')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Borrar un tablero y sus tarjetas (cascade).' })
  async deleteBoard(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<{ deleted: true }> {
    await this.kanbanService.deleteBoard(id, companyId);
    this.notify(companyId, { boardId: id });
    return { deleted: true };
  }

  // ─── Tarjetas ─────────────────────────────────────────────────────────────

  @Post('boards/:boardId/cards')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Crear una tarjeta al final de un tablero.' })
  async createCard(
    @Param('boardId', ParseIntPipe) boardId: number,
    @Body() dto: CreateCardDto,
    @CurrentCompany() companyId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<KanbanCardDto> {
    const card = await this.kanbanService.createCard(boardId, dto, companyId, this.actorOf(user));
    this.notify(companyId, { boardId, cardId: Number(card.id) });
    return toCardDto(card);
  }

  @Patch('cards/:id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Editar el contenido de una tarjeta.' })
  async updateCard(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCardDto,
    @CurrentCompany() companyId: number,
  ): Promise<KanbanCardDto> {
    const card = await this.kanbanService.updateCard(id, dto, companyId);
    this.notify(companyId, { boardId: Number(card.board_id), cardId: id });
    return toCardDto(card);
  }

  @Patch('cards/:id/move')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Mover una tarjeta (dentro o entre tableros).' })
  async moveCard(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MoveCardDto,
    @CurrentCompany() companyId: number,
  ): Promise<KanbanCardDto> {
    const card = await this.kanbanService.moveCard(id, dto, companyId);
    this.notify(companyId, { boardId: dto.board_id, cardId: id });
    return toCardDto(card);
  }

  @Delete('cards/:id')
  @Roles('owner', 'manager', 'employee')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Borrar una tarjeta.' })
  async deleteCard(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<{ deleted: true }> {
    await this.kanbanService.deleteCard(id, companyId);
    this.notify(companyId, { cardId: id });
    return { deleted: true };
  }

  // ─── Checklist ────────────────────────────────────────────────────────────

  @Get('cards/:cardId/checklist')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Checklist (lista de tareas) de una tarjeta.' })
  getChecklist(
    @Param('cardId', ParseIntPipe) cardId: number,
    @CurrentCompany() companyId: number,
  ): Promise<ChecklistItemDto[]> {
    return this.kanbanService.getChecklist(cardId, companyId);
  }

  @Post('cards/:cardId/checklist')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Añadir una tarea al checklist de una tarjeta.' })
  async createChecklistItem(
    @Param('cardId', ParseIntPipe) cardId: number,
    @Body() dto: CreateChecklistItemDto,
    @CurrentCompany() companyId: number,
  ): Promise<ChecklistItemDto> {
    const item = await this.kanbanService.createChecklistItem(cardId, dto, companyId);
    this.notify(companyId, { cardId });
    return toChecklistItemDto(item);
  }

  @Patch('checklist/:id')
  @Roles('owner', 'manager', 'employee')
  @ApiOperation({ summary: 'Editar/marcar una tarea del checklist.' })
  async updateChecklistItem(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateChecklistItemDto,
    @CurrentCompany() companyId: number,
  ): Promise<ChecklistItemDto> {
    const item = await this.kanbanService.updateChecklistItem(id, dto, companyId);
    this.notify(companyId, { cardId: Number(item.card_id) });
    return toChecklistItemDto(item);
  }

  @Delete('checklist/:id')
  @Roles('owner', 'manager', 'employee')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Borrar una tarea del checklist.' })
  async deleteChecklistItem(
    @Param('id', ParseIntPipe) id: number,
    @CurrentCompany() companyId: number,
  ): Promise<{ deleted: true }> {
    await this.kanbanService.deleteChecklistItem(id, companyId);
    this.notify(companyId);
    return { deleted: true };
  }
}
