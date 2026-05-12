import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, type FindOptionsWhere, ILike, MoreThanOrEqual, Repository } from 'typeorm';

import type { ListExpensesQueryDto } from '../dto/list-expenses-query.dto';
import { Expense } from '../entities/expense.entity';

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

    const where: FindOptionsWhere<Expense> = { company_id: String(companyId) };

    // Filtro de archivo. Cuando includeArchived=true devolvemos todo (paridad
    // PlacePos que también incluye y diferencia con activeCount).
    if (!includeArchived) {
      where.is_archived = false;
    }

    // Rango de fechas (usando `expense_date` — la fecha contable, no
    // created_at; paridad PlacePos que usa created_at pero aquí preferimos
    // expense_date que es el campo que el usuario controla).
    if (query.date_from && query.date_to) {
      where.expense_date = Between(
        new Date(`${query.date_from}T00:00:00.000Z`),
        new Date(`${query.date_to}T23:59:59.999Z`),
      );
    } else if (query.date_from) {
      where.expense_date = MoreThanOrEqual(new Date(`${query.date_from}T00:00:00.000Z`));
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
