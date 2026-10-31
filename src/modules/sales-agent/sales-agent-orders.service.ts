import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository, type SelectQueryBuilder } from 'typeorm';

import { parseUtcRange } from '@/modules/reports/internal/range';
import {
  AGENT_ORDERS_CHANGED_EVENT,
  ALERT_CREATED_EVENT,
  RealtimeGateway,
} from '@/modules/realtime/realtime.gateway';

import {
  SalesAgentOrderEntity,
  type SalesAgentOrderItem,
  type SalesAgentOrderStatus,
} from './entities/sales-agent-order.entity';
import { canTransition, normalizeStatusNote, type AgentOrderRecord } from './internal/agent-order';
import {
  buildAgentOrderAlert,
  type AgentOrderAlertData,
  type AgentOrderEventKind,
} from './internal/agent-alerts';
import { AppAlert } from '@/modules/app-alerts/entities/app-alert.entity';
import { PushNotificationsService } from '@/modules/push-notifications/push-notifications.service';

/** Filtro de estado del listado (`all` = todos). */
export type AgentOrderStatusFilter = SalesAgentOrderStatus | 'all';

export interface ListAgentOrdersParams {
  status: AgentOrderStatusFilter;
  /** Rango opcional (días Colombia, YYYY-MM-DD). Ambos o ninguno. */
  from?: string;
  to?: string;
  /** Busca por referencia, nombre del cliente o teléfono. */
  search?: string;
  page: number;
  limit: number;
}

/** Pedido tal cual lo ve el informe (sin `company`). */
export interface AgentOrderView {
  id: number;
  reference: string;
  status: SalesAgentOrderStatus;
  channel: string;
  channel_account: string | null;
  chat_id: string;
  chat_display_name: string | null;
  chat_phone: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_mode: 'domicilio' | 'recoger';
  delivery_address: string | null;
  payment_method: string | null;
  notes: string | null;
  items: SalesAgentOrderItem[];
  items_count: number;
  total: number;
  status_note: string | null;
  status_changed_at: string | null;
  status_changed_by: string | null;
  /** Ticket del POS donde se registró (consecutivo vigente) o `null`. */
  ticket: AgentOrderTicket | null;
  /** Última vez que el cliente lo modificó (antes de que lo tomaran). */
  customer_updated_at: string | null;
  /** Lo descartó el cliente (no el negocio). */
  cancelled_by_customer: boolean;
  /** Solicitud del cliente sobre el pedido ya tomado (cambiar o cancelar). */
  customer_request: string | null;
  customer_request_at: string | null;
  created_at: string;
}

export interface AgentOrdersSummary {
  /** Por tomar: SIEMPRE el total vigente, sin importar el rango. */
  pending_count: number;
  pending_total: number;
  /** Del rango (o de todo, sin rango). */
  taken_count: number;
  taken_total: number;
  dismissed_count: number;
}

export interface AgentOrdersList {
  items: AgentOrderView[];
  total_count: number;
  page: number;
  limit: number;
  summary: AgentOrdersSummary;
}

/**
 * Ticket del POS enlazado. `number` es el consecutivo VIGENTE: PED-x mientras
 * sea pedido, VTA-x cuando se cobró (con `is_credit` si quedó a crédito).
 */
export interface AgentOrderTicket {
  id: number;
  type: 'ORDER' | 'SALE' | 'LOAN';
  number: string;
  is_credit: boolean;
  /** El ticket fue anulado: el pedido se puede volver a tomar. */
  is_voided: boolean;
}

/** Columnas extra del listado (joins). */
interface RawExtras {
  changed_by_name?: string | null;
  ticket_type?: 'ORDER' | 'SALE' | 'LOAN' | null;
  ticket_number?: string | null;
  sale_number?: string | null;
  ticket_is_credit?: boolean | null;
  ticket_is_voided?: boolean | null;
}

/** Fila del listado (entidad + joins). */
type OrderRow = SalesAgentOrderEntity & RawExtras;

const withExtras = (entity: SalesAgentOrderEntity, raw: unknown): OrderRow => {
  const extras = (raw ?? {}) as RawExtras;
  return {
    ...entity,
    changed_by_name: extras.changed_by_name,
    ticket_type: extras.ticket_type,
    ticket_number: extras.ticket_number,
    sale_number: extras.sale_number,
    ticket_is_credit: extras.ticket_is_credit,
    ticket_is_voided: extras.ticket_is_voided,
  };
};

/**
 * Bandeja de pedidos del agente de ventas (`sales_agent_orders`). Guarda el
 * pedido al cerrar (idempotente por `operation_id`), lo lista para el informe
 * "Agente" y cambia su estado. Cada cambio avisa por tiempo real
 * (`agent-orders:changed`) para que el informe se refresque sin recargar.
 */
@Injectable()
export class SalesAgentOrdersService {
  private readonly logger = new Logger(SalesAgentOrdersService.name);

  constructor(
    @InjectRepository(SalesAgentOrderEntity)
    private readonly repo: Repository<SalesAgentOrderEntity>,
    private readonly realtime: RealtimeGateway,
    @InjectRepository(AppAlert)
    private readonly alerts: Repository<AppAlert>,
    private readonly push: PushNotificationsService,
  ) {}

  /**
   * Guarda el pedido que cerró el agente. Idempotente: si ese carrito
   * (`operation_id`) ya se guardó, no duplica ni vuelve a avisar.
   * @returns `true` si lo insertó ahora.
   */
  async record(
    companyId: number,
    record: AgentOrderRecord,
  ): Promise<{ id: string; inserted: boolean }> {
    const result = await this.repo
      .createQueryBuilder()
      .insert()
      .into(SalesAgentOrderEntity)
      .values({ ...record, company_id: String(companyId), total: Number(record.total) })
      .orIgnore()
      .returning(['id'])
      .execute();
    // ON CONFLICT DO NOTHING no devuelve fila: vacío = ya estaba guardado.
    const rows = Array.isArray(result.raw) ? (result.raw as Array<{ id: string }>) : [];
    if (rows[0]) {
      const id = String(rows[0].id);
      this.notify(companyId, {
        reason: 'created',
        reference: record.reference,
        order_id: Number(id),
      });
      await this.alert(companyId, 'new', {
        order_id: id,
        reference: record.reference,
        total: Number(record.total),
        items_count: record.items_count,
        customer_name: record.customer_name ?? record.chat_display_name,
        channel: record.channel,
      });
      return { id, inserted: true };
    }
    const existing = await this.repo.findOne({
      where: { company_id: String(companyId), operation_id: record.operation_id },
      select: { id: true },
    });
    return { id: existing?.id ?? '', inserted: false };
  }

  /**
   * El CLIENTE cambió su pedido: se actualiza el MISMO pedido (misma
   * referencia) solo si sigue por tomar y sin ticket. La condición va en el
   * UPDATE: si una persona lo tomó entretanto, no se pisa (`locked`).
   */
  async amendByCustomer(
    companyId: number,
    orderId: string,
    record: AgentOrderRecord,
  ): Promise<'updated' | 'locked'> {
    const rows = await this.repo.query<[EventRow[], number]>(
      `UPDATE sales_agent_orders
          SET items = $3::jsonb, items_count = $4, total = $5,
              customer_name = $6, customer_phone = $7, delivery_mode = $8,
              delivery_address = $9, payment_method = $10, notes = $11,
              customer_updated_at = now(), updated_at = now()
        WHERE id = $1 AND company_id = $2
          AND status = 'pending' AND sale_invoice_id IS NULL
        RETURNING id, reference, total, items_count, customer_name, chat_display_name, channel`,
      [
        orderId,
        companyId,
        JSON.stringify(record.items),
        record.items_count,
        record.total,
        record.customer_name,
        record.customer_phone,
        record.delivery_mode,
        record.delivery_address,
        record.payment_method,
        record.notes,
      ],
    );
    // manager.query con UPDATE…RETURNING devuelve [filas, conteo].
    const updated = Array.isArray(rows[0]) ? rows[0] : [];
    if (!updated[0]) {
      return 'locked';
    }
    this.notify(companyId, {
      reason: 'updated',
      reference: updated[0].reference,
      order_id: Number(updated[0].id),
    });
    await this.alert(companyId, 'updated', eventData(updated[0]));
    return 'updated';
  }

  /**
   * El CLIENTE cancela su pedido: queda descartado POR EL CLIENTE solo si
   * sigue por tomar y sin ticket (condición en el UPDATE).
   */
  async cancelByCustomer(
    companyId: number,
    orderId: string,
    reason: string | null,
  ): Promise<'cancelled' | 'locked'> {
    const note = normalizeStatusNote(
      reason ? `Cancelado por el cliente: ${reason}` : 'Cancelado por el cliente',
    );
    const rows = await this.repo.query<[EventRow[], number]>(
      `UPDATE sales_agent_orders
          SET status = 'dismissed', cancelled_by_customer = true, status_note = $3,
              status_changed_at = now(), status_changed_by_user_id = NULL, updated_at = now()
        WHERE id = $1 AND company_id = $2
          AND status = 'pending' AND sale_invoice_id IS NULL
        RETURNING id, reference, total, items_count, customer_name, chat_display_name, channel`,
      [orderId, companyId, note],
    );
    const updated = Array.isArray(rows[0]) ? rows[0] : [];
    if (!updated[0]) {
      return 'locked';
    }
    this.notify(companyId, {
      reason: 'cancelled',
      reference: updated[0].reference,
      order_id: Number(updated[0].id),
    });
    await this.alert(companyId, 'cancelled', { ...eventData(updated[0]), detail: reason });
    return 'cancelled';
  }

  /**
   * Solicitud del cliente sobre un pedido YA tomado (cambiar o cancelar): no se
   * toca el pedido; queda anotada para que el equipo la atienda.
   */
  async recordCustomerRequest(companyId: number, orderId: string, request: string): Promise<void> {
    const text = request.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) {
      return;
    }
    const result = await this.repo.update(
      { id: orderId, company_id: String(companyId) },
      { customer_request: text, customer_request_at: new Date() },
    );
    if (result.affected) {
      const order = await this.repo.findOne({
        where: { id: orderId, company_id: String(companyId) },
      });
      this.notify(companyId, {
        reason: 'customer_request',
        reference: order?.reference ?? '',
        order_id: Number(orderId),
      });
      if (order) {
        await this.alert(companyId, 'request', {
          order_id: order.id,
          reference: order.reference,
          total: Number(order.total),
          items_count: order.items_count,
          customer_name: order.customer_name ?? order.chat_display_name,
          channel: order.channel,
          detail: text,
        });
      }
    }
  }

  async list(companyId: number, params: ListAgentOrdersParams): Promise<AgentOrdersList> {
    const range = this.readRange(params.from, params.to);

    const listQuery = this.baseQuery(companyId);
    if (params.status !== 'all') {
      listQuery.andWhere('o.status = :status', { status: params.status });
    }
    if (range) {
      listQuery.andWhere('o.created_at BETWEEN :dateStart AND :dateEnd', range);
    }
    const search = params.search?.trim();
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      listQuery.andWhere(
        new Brackets((qb) => {
          qb.where('o.reference ILIKE :like', { like })
            .orWhere('si.ticket_number ILIKE :like', { like })
            .orWhere('si.sale_number ILIKE :like', { like })
            .orWhere('o.customer_name ILIKE :like', { like })
            .orWhere('o.chat_display_name ILIKE :like', { like })
            .orWhere('o.customer_phone ILIKE :like', { like })
            .orWhere('o.chat_phone ILIKE :like', { like });
          // Teléfono escrito como lo muestra WhatsApp ("+57 316 138 4577"):
          // se compara solo por dígitos.
          const digits = search.replace(/\D/g, '');
          if (digits.length >= 4) {
            qb.orWhere(
              "regexp_replace(COALESCE(o.chat_phone, ''), '\\D', '', 'g') LIKE :digits OR regexp_replace(COALESCE(o.customer_phone, ''), '\\D', '', 'g') LIKE :digits",
              { digits: `%${digits}%` },
            );
          }
        }),
      );
    }

    // Lo más reciente arriba (también en "por tomar": así llega lo nuevo).
    listQuery
      .orderBy('o.created_at', 'DESC')
      .addOrderBy('o.id', 'DESC')
      .offset((params.page - 1) * params.limit)
      .limit(params.limit);

    const [rows, totalCount, summary] = await Promise.all([
      listQuery.getRawAndEntities(),
      listQuery.clone().offset(undefined).limit(undefined).orderBy().getCount(),
      this.summary(companyId, range),
    ]);

    return {
      items: rows.entities.map((entity, index) => toView(withExtras(entity, rows.raw[index]))),
      total_count: totalCount,
      page: params.page,
      limit: params.limit,
      summary,
    };
  }

  /** Pedidos por tomar (para el contador del menú). */
  pendingCount(companyId: number): Promise<number> {
    return this.repo.count({ where: { company_id: String(companyId), status: 'pending' } });
  }

  async findOne(companyId: number, id: number): Promise<AgentOrderView> {
    const query = this.baseQuery(companyId).andWhere('o.id = :id', { id });
    const { entities, raw } = await query.getRawAndEntities();
    if (!entities[0]) {
      throw new NotFoundException('Pedido del agente no encontrado.');
    }
    return toView(withExtras(entities[0], raw[0]));
  }

  /** Cambia el estado (por tomar ↔ tomado / descartado). */
  async updateStatus(
    companyId: number,
    id: number,
    input: { status: SalesAgentOrderStatus; note?: string; userId: number },
  ): Promise<AgentOrderView> {
    const order = await this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
    });
    if (!order) {
      throw new NotFoundException('Pedido del agente no encontrado.');
    }
    if (order.status === input.status) {
      return this.findOne(companyId, id);
    }
    if (!canTransition(order.status, input.status)) {
      throw new BadRequestException({
        code: 'AGENT_ORDER_INVALID_TRANSITION',
        message: 'Ese cambio de estado no está permitido. Primero devuélvelo a "Por tomar".',
      });
    }
    // Ya está en un ticket vivo: volverlo "por tomar" invita a facturarlo dos
    // veces. Si el ticket se anuló, sí se puede (y se suelta el enlace).
    const linkedTicket = order.sale_invoice_id ? (await this.findOne(companyId, id)).ticket : null;
    if (input.status === 'pending' && linkedTicket && !linkedTicket.is_voided) {
      throw new BadRequestException({
        code: 'AGENT_ORDER_HAS_TICKET',
        message: `Este pedido ya está registrado en el ticket ${linkedTicket.number}. Anula ese ticket antes de devolverlo a "Por tomar".`,
      });
    }

    // Condicional por el estado leído: si otro usuario lo cambió entretanto,
    // no se pisa su cambio.
    const result = await this.repo.update(
      { id: order.id, company_id: order.company_id, status: order.status },
      {
        status: input.status,
        // Volver a "por tomar" limpia la nota (se deshizo el cambio).
        status_note: input.status === 'pending' ? null : normalizeStatusNote(input.note),
        status_changed_at: new Date(),
        status_changed_by_user_id: String(input.userId),
        ...(input.status === 'pending' ? { sale_invoice_id: null } : {}),
      },
    );
    if (!result.affected) {
      throw new BadRequestException({
        code: 'AGENT_ORDER_STATUS_CONFLICT',
        message: 'Otro usuario cambió este pedido. Actualiza la vista e inténtalo de nuevo.',
      });
    }
    this.notify(companyId, { reason: 'status_changed', reference: order.reference });
    return this.findOne(companyId, id);
  }

  /**
   * Enlaza el pedido con el ticket que se registró en el POS a partir de él y lo
   * deja TOMADO. Idempotente con el mismo ticket. El ticket tiene que ser del
   * negocio y estar vivo, y no puede estar ya enlazado a otro pedido.
   */
  async linkTicket(
    companyId: number,
    id: number,
    input: { saleInvoiceId: number; userId: number },
  ): Promise<AgentOrderView> {
    const order = await this.repo.findOne({
      where: { id: String(id), company_id: String(companyId) },
    });
    if (!order) {
      throw new NotFoundException('Pedido del agente no encontrado.');
    }
    if (order.sale_invoice_id === String(input.saleInvoiceId)) {
      return this.findOne(companyId, id);
    }
    if (order.sale_invoice_id) {
      const current = (await this.findOne(companyId, id)).ticket;
      if (current && !current.is_voided) {
        throw new ConflictException({
          code: 'AGENT_ORDER_ALREADY_LINKED',
          message: `Este pedido ya está registrado en el ticket ${current.number}.`,
        });
      }
    }

    const tickets = await this.repo.query<Array<{ id: string }>>(
      `SELECT id FROM sale_invoices WHERE id = $1 AND company_id = $2 AND is_deleted = false LIMIT 1`,
      [input.saleInvoiceId, companyId],
    );
    if (!tickets[0]) {
      throw new NotFoundException('El ticket no existe o fue anulado.');
    }
    const taken = await this.repo.count({
      where: { company_id: String(companyId), sale_invoice_id: String(input.saleInvoiceId) },
    });
    if (taken > 0) {
      throw new ConflictException({
        code: 'AGENT_TICKET_ALREADY_LINKED',
        message: 'Ese ticket ya está enlazado a otro pedido del agente.',
      });
    }

    await this.repo.update(
      { id: order.id, company_id: order.company_id },
      {
        sale_invoice_id: String(input.saleInvoiceId),
        status: 'taken',
        status_note: null,
        status_changed_at: new Date(),
        status_changed_by_user_id: String(input.userId),
      },
    );
    this.notify(companyId, { reason: 'status_changed', reference: order.reference });
    return this.findOne(companyId, id);
  }

  private baseQuery(companyId: number): SelectQueryBuilder<SalesAgentOrderEntity> {
    return (
      this.repo
        .createQueryBuilder('o')
        .leftJoin('users', 'u', 'u.id = o.status_changed_by_user_id')
        .addSelect("NULLIF(TRIM(CONCAT(u.name, ' ', u.lastname)), '')", 'changed_by_name')
        // Consecutivo VIGENTE del ticket enlazado (PED-x → VTA-x) y si es crédito.
        .leftJoin(
          'sale_invoices',
          'si',
          'si.id = o.sale_invoice_id AND si.company_id = o.company_id',
        )
        .addSelect('si.ticket_type', 'ticket_type')
        .addSelect('si.ticket_number', 'ticket_number')
        .addSelect('si.sale_number', 'sale_number')
        .addSelect('si.is_deleted', 'ticket_is_voided')
        .addSelect(
          'EXISTS (SELECT 1 FROM sale_credits sc WHERE sc.sale_invoice_id = si.id)',
          'ticket_is_credit',
        )
        .where('o.company_id = :companyId', { companyId })
    );
  }

  private async summary(
    companyId: number,
    range: { dateStart: Date; dateEnd: Date } | null,
  ): Promise<AgentOrdersSummary> {
    const rangeSql = range ? 'AND created_at BETWEEN $2 AND $3' : '';
    const params: unknown[] = range ? [companyId, range.dateStart, range.dateEnd] : [companyId];
    const rows = await this.repo.query<
      Array<{
        pending_count: string;
        pending_total: string;
        taken_count: string;
        taken_total: string;
        dismissed_count: string;
      }>
    >(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')                      AS pending_count,
         COALESCE(SUM(total) FILTER (WHERE status = 'pending'), 0)       AS pending_total,
         COUNT(*) FILTER (WHERE status = 'taken' ${rangeSql})            AS taken_count,
         COALESCE(SUM(total) FILTER (WHERE status = 'taken' ${rangeSql}), 0) AS taken_total,
         COUNT(*) FILTER (WHERE status = 'dismissed' ${rangeSql})        AS dismissed_count
       FROM sales_agent_orders
       WHERE company_id = $1`,
      params,
    );
    const row = rows[0];
    return {
      pending_count: Number(row?.pending_count ?? 0),
      pending_total: Number(row?.pending_total ?? 0),
      taken_count: Number(row?.taken_count ?? 0),
      taken_total: Number(row?.taken_total ?? 0),
      dismissed_count: Number(row?.dismissed_count ?? 0),
    };
  }

  private readRange(from?: string, to?: string): { dateStart: Date; dateEnd: Date } | null {
    if (!from && !to) {
      return null;
    }
    if (!from || !to) {
      throw new BadRequestException('Envía "from" y "to" juntos (YYYY-MM-DD).');
    }
    const { dateStart, dateEnd } = parseUtcRange(from, to);
    return { dateStart, dateEnd };
  }

  /**
   * Notificación de la campana por un evento del CLIENTE (pedido nuevo,
   * actualizado, cancelado o solicitud). Best-effort: si falla, el pedido sigue
   * su curso (la bandeja ya lo muestra).
   */
  private async alert(
    companyId: number,
    kind: AgentOrderEventKind,
    data: AgentOrderAlertData,
  ): Promise<void> {
    try {
      const alert = buildAgentOrderAlert(kind, data);
      await this.alerts.save(
        this.alerts.create({
          company_id: String(companyId),
          type: alert.type,
          severity: alert.severity,
          title: alert.title,
          message: alert.message,
          metadata: alert.metadata,
        }),
      );
      this.realtime.emitAlertCreated(companyId, {
        companyId,
        alertType: alert.type,
        severity: alert.severity,
      });
      const companyName = await this.notifyOwners(companyId, kind, data, alert);
      // Push a los celulares/tabletas (PWA). No se espera: no frena al agente.
      this.push
        .notifyAgentOrder({
          company_id: companyId,
          company_name: companyName ?? '',
          order_id: Number(data.order_id),
          title: alert.title,
          body: alert.message,
        })
        .catch((error: unknown) =>
          this.logger.warn({ err: error, companyId }, 'No pude enviar el push del pedido.'),
        );
    } catch (error) {
      this.logger.warn(
        { err: error, companyId, kind },
        'No pude crear la notificación del pedido.',
      );
    }
  }

  /**
   * Avisa a los DUEÑOS del negocio por su room de usuario: les llega aunque
   * estén parados en otra sucursal (la campana se enciende y sale la
   * notificación del sistema con el nombre de la sucursal). Lleva lo justo para
   * la notificación, porque ese pedido no es del negocio que tienen abierto.
   */
  private async notifyOwners(
    companyId: number,
    kind: AgentOrderEventKind,
    data: AgentOrderAlertData,
    alert: { type: string; severity: string },
  ): Promise<string | null> {
    const owners = await this.repo.query<Array<{ user_id: string; company_name: string }>>(
      `SELECT cm.user_id, c.name AS company_name
         FROM company_members cm
         JOIN companies c ON c.id = cm.company_id
        WHERE cm.company_id = $1 AND cm.role = 'owner' AND cm.is_active = true`,
      [companyId],
    );
    const userIds = owners
      .map((owner) => Number(owner.user_id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
    if (userIds.length === 0) {
      return owners[0]?.company_name ?? null;
    }
    this.realtime.emitToUsers(userIds, ALERT_CREATED_EVENT, {
      companyId,
      alertType: alert.type,
      severity: alert.severity,
    });
    this.realtime.emitToUsers(userIds, AGENT_ORDERS_CHANGED_EVENT, {
      companyId,
      reason: EVENT_REASON[kind],
      reference: data.reference,
      order_id: Number(data.order_id),
      company_id: companyId,
      company_name: owners[0].company_name,
      customer_name: data.customer_name,
      total: data.total,
      items_count: data.items_count,
    });
    return owners[0].company_name;
  }

  /** Señal de tiempo real; un fallo de socket nunca rompe la operación. */
  private notify(
    companyId: number,
    payload: {
      reason: 'created' | 'status_changed' | 'updated' | 'cancelled' | 'customer_request';
      reference: string;
      order_id?: number;
    },
  ): void {
    try {
      this.realtime.emitAgentOrdersChanged(companyId, payload);
    } catch (error) {
      this.logger.warn({ err: error, companyId }, 'No pude emitir agent-orders:changed.');
    }
  }
}

const toView = (row: OrderRow): AgentOrderView => ({
  id: Number(row.id),
  reference: row.reference,
  status: row.status,
  channel: row.channel,
  channel_account: row.channel_account,
  chat_id: row.chat_id,
  chat_display_name: row.chat_display_name,
  chat_phone: row.chat_phone,
  customer_name: row.customer_name,
  customer_phone: row.customer_phone,
  delivery_mode: row.delivery_mode,
  delivery_address: row.delivery_address,
  payment_method: row.payment_method,
  notes: row.notes,
  items: row.items ?? [],
  items_count: row.items_count,
  total: Number(row.total),
  status_note: row.status_note,
  status_changed_at: row.status_changed_at ? row.status_changed_at.toISOString() : null,
  status_changed_by: row.changed_by_name ?? null,
  ticket: toTicket(row),
  customer_updated_at: row.customer_updated_at ? row.customer_updated_at.toISOString() : null,
  cancelled_by_customer: row.cancelled_by_customer === true,
  customer_request: row.customer_request ?? null,
  customer_request_at: row.customer_request_at ? row.customer_request_at.toISOString() : null,
  created_at: row.created_at.toISOString(),
});

const toTicket = (row: OrderRow): AgentOrderTicket | null => {
  if (!row.sale_invoice_id || !row.ticket_type || !row.ticket_number) {
    return null;
  }
  const isSale = row.ticket_type === 'SALE' && Boolean(row.sale_number);
  return {
    id: Number(row.sale_invoice_id),
    type: row.ticket_type,
    number: isSale ? (row.sale_number as string) : row.ticket_number,
    is_credit: row.ticket_is_credit === true,
    is_voided: row.ticket_is_voided === true,
  };
};

/** Fila que devuelven los UPDATE de eventos del cliente. */
interface EventRow {
  id: string;
  reference: string;
  total: string;
  items_count: number;
  customer_name: string | null;
  chat_display_name: string | null;
  channel: string;
}

const eventData = (row: EventRow): AgentOrderAlertData => ({
  order_id: String(row.id),
  reference: row.reference,
  total: Number(row.total),
  items_count: Number(row.items_count),
  customer_name: row.customer_name ?? row.chat_display_name,
  channel: row.channel,
});

/** Evento del cliente → `reason` del aviso en tiempo real. */
const EVENT_REASON: Record<AgentOrderEventKind, string> = {
  new: 'created',
  updated: 'updated',
  cancelled: 'cancelled',
  request: 'customer_request',
};
