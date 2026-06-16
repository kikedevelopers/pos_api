import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  type FindOptionsWhere,
  ILike,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';

import { APP_TIMEZONE, dayjs } from '@/common/utils/dayjs';

import type { ListExpensesQueryDto } from '../dto/list-expenses-query.dto';
import { Expense } from '../entities/expense.entity';

/** Inicio del día COLOMBIANO (`YYYY-MM-DD`) como instante UTC. */
const dayStartBogota = (d: string): Date => dayjs.tz(`${d} 00:00:00.000`, APP_TIMEZONE).toDate();
/** Fin del día COLOMBIANO (`YYYY-MM-DD`) como instante UTC. */
const dayEndBogota = (d: string): Date => dayjs.tz(`${d} 23:59:59.999`, APP_TIMEZONE).toDate();

/**
 * Resultado del listado paginado. Espejo PlacePos extendido con `limit`/
 * `offset` para que el frontend pueda paginar.
 */
export interface ListExpensesResult {
  expenses: Expense[];
  total: number;
  totalAmount: number;
  activeCount: number;
  limit: number;
  offset: number;
}

/**
 * Lista los gastos de una company aplicando filtros opcionales. Espejo de
 * `GET /expenses` de PlacePos (search, date_from, date_to) + filtros de cloud
 * (category, source_type, source_id) + paginación opt-in.
 *
 * **Multi-tenancy**: filtro `company_id` SIEMPRE aplicado. Si el caller
 * omite el filtro, la query falla — no leak cross-tenant.
 *
 * **Performance**: index parcial `(company_id, expense_date DESC) WHERE
 * is_archived = false` cubre el caso por defecto (lista del feed). Filtros
 * adicionales se sirven por los índices `(company_id, category)` y
 * `(company_id, source_type, source_id)`.
 */
@Injectable()
export class FindAllExpensesAction {
  constructor(
    @InjectRepository(Expense)
    private readonly expensesRepo: Repository<Expense>,
  ) {}

  async execute(companyId: number, query: ListExpensesQueryDto): Promise<ListExpensesResult> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const includeArchived = query.includeArchived === 'true';

    const where: FindOptionsWhere<Expense> = {
      company_id: String(companyId),
      // El listado de gastos es SOLO de gastos variables. Los pagos de gastos
      // fijos (`is_fixed = true`) materializan filas en `expenses` pero se
      // gestionan/visualizan exclusivamente en el módulo de Gastos Fijos.
      is_fixed: false,
    };

    // Filtro de archivo. Cuando includeArchived=true devolvemos todo (paridad
    // PlacePos que también incluye y diferencia con activeCount).
    if (!includeArchived) {
      where.is_archived = false;
    }

    // Rango de fechas. Filtramos por `expense_date` (la fecha contable) pero
    // interpretando los límites en hora COLOMBIA (no UTC) — regla global
    // dayjs/America/Bogota. Un gasto de la tarde-noche de ayer (Colombia) NO
    // debe caer en el "hoy" de hoy. Espejo del día colombiano de PlacePos.
    if (query.date_from && query.date_to) {
      where.expense_date = Between(
        dayStartBogota(query.date_from),
        dayEndBogota(query.date_to),
      );
    } else if (query.date_from) {
      where.expense_date = MoreThanOrEqual(dayStartBogota(query.date_from));
    } else if (query.date_to) {
      // MED-1 auditoría: antes se ignoraba silenciosamente `date_to` cuando
      // venía sin `date_from`.
      where.expense_date = LessThanOrEqual(dayEndBogota(query.date_to));
    }

    if (query.search) {
      where.description = ILike(`%${query.search}%`);
    }

    if (query.category) {
      where.category = query.category;
    }

    if (query.source_type) {
      where.source_type = query.source_type;
    }

    if (query.source_id !== undefined) {
      where.source_id = String(query.source_id);
    }

    const [rows, total] = await this.expensesRepo.findAndCount({
      where,
      order: { expense_date: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    });

    // Totales agregados. Los calculamos en TS con Number ya que `amount` ya
    // viene como number (transformer). Para conjuntos grandes habría que
    // hacer un SUM en DB, pero el listado se limita a 200 rows max por
    // paginación. Si en el futuro el dashboard pide totales del histórico
    // completo, se hace un endpoint dedicado con SUM en DB.
    const activeRows = rows.filter((r) => !r.is_archived);
    const totalAmount = activeRows.reduce((acc, r) => acc + Number(r.amount), 0);

    return {
      expenses: rows,
      total,
      totalAmount,
      activeCount: activeRows.length,
      limit,
      offset,
    };
  }
}
