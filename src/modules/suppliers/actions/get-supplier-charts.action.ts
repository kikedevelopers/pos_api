import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import { findSupplierInCompany } from '../internal/supplier-lookups';

/**
 * Endpoint `GET /suppliers/:id/charts` (extensión cloud — no existe en
 * PlacePos local). Devuelve una serie temporal de compras al supplier.
 *
 * En Fase 4 las entidades `Purchase` / `PurchaseLine` no existen. Devolvemos
 * `points: []`.
 *
 * TODO(Fase 8): reemplazar con CTE sobre `purchases` agrupando por día,
 * filtrando supplier_id + company_id.
 */
export interface SupplierChartsResponse {
  startDate: string;
  endDate: string;
  points: { date: string; total: number; paid: number; pending: number }[];
}

function parseChartRange(
  startDate?: string,
  endDate?: string,
): { startDate: string; endDate: string } {
  const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

  if (startDate !== undefined && !DATE_REGEX.test(startDate)) {
    throw new BadRequestException('Rango de fechas inválido');
  }
  if (endDate !== undefined && !DATE_REGEX.test(endDate)) {
    throw new BadRequestException('Rango de fechas inválido');
  }

  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const resolvedEnd = endDate ?? todayLocal;

  let resolvedStart: string;
  if (startDate) {
    resolvedStart = startDate;
  } else {
    const base = new Date(`${resolvedEnd}T00:00:00`);
    base.setDate(base.getDate() - 30);
    resolvedStart = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  }

  if (resolvedStart > resolvedEnd) {
    throw new BadRequestException('Rango de fechas inválido');
  }

  return { startDate: resolvedStart, endDate: resolvedEnd };
}

@Injectable()
export class GetSupplierChartsAction {
  constructor(
    @InjectRepository(Supplier)
    private readonly repo: Repository<Supplier>,
  ) {}

  async execute(
    id: number,
    companyId: number,
    startDate?: string,
    endDate?: string,
  ): Promise<SupplierChartsResponse> {
    await findSupplierInCompany(this.repo.manager, id, companyId);
    const range = parseChartRange(startDate, endDate);

    return {
      startDate: range.startDate,
      endDate: range.endDate,
      points: [],
    };
  }
}
