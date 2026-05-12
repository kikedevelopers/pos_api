import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';

import { Customer } from '@/modules/customers/entities/customer.entity';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';

import type { UpdateSaleDto } from '../dto/update-sale.dto';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { SalePayment } from '../entities/sale-payment.entity';
import { calculateSaleTotals } from '../internal/calculate-sale-totals';
import { translateSaleConstraintError } from '../internal/constraint-errors';
import {
  findSaleCredit,
  findSaleInCompany,
  findSaleLines,
  findSalePayments,
} from '../internal/sale-lookups';
import type { SaleAggregate } from './find-sale.action';

/**
 * Modifica una venta — SOLO si `ticket_type = 'ORDER'` y NO tiene pagos
 * aplicados.
 *
 * Espejo del comportamiento PlacePos (`editTicket`): una vez que la venta
 * pasa a SALE o recibe el primer cobro, queda inmutable. Para corregirla
 * se usa una CreditNote (Fase 8).
 *
 * --------------------------------------------------------------------------
 * Pasos (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. Lock pessimistic_write sobre la venta.
 *   2. Validar ticket_type = ORDER. Si SALE → 422 con código
 *      `SALE_NOT_EDITABLE`.
 *   3. Validar que NO existan pagos para esta venta. Si los hay → 422.
 *   4. Si DTO trae `customer_id`, validar ownership y actualizar snapshot.
 *   5. Si DTO trae `lines`, validar productos/packagings/precios,
 *      recalcular totales con Big.js, DELETE old lines + INSERT new lines,
 *      UPDATE cabecera con totales.
 *   6. Si NO trae `lines`, actualiza solo notes/customer.
 *
 * No tocamos `Customer.balance` aquí — la venta ORDER NO genera SaleCredit
 * (solo SALE puede; Order es borrador).
 */
@Injectable()
export class UpdateSaleAction {
  private readonly logger = new Logger(UpdateSaleAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    id: number,
    dto: UpdateSaleDto,
    companyId: number,
    actorId: number,
  ): Promise<SaleAggregate> {
    return this.dataSource.transaction<SaleAggregate>(async (manager) => {
      const sale = await findSaleInCompany(manager, id, companyId, {
        requireActive: true,
        lock: true,
      });

      if (sale.ticket_type !== TicketType.ORDER) {
        throw new UnprocessableEntityException({
          message: 'Venta confirmada no editable. Usa una nota de crédito para reversarla.',
          payload: { code: 'SALE_NOT_EDITABLE' },
        });
      }

      const paymentsCount = await manager.count(SalePayment, {
        where: { sale_invoice_id: sale.id, company_id: String(companyId) },
      });
      if (paymentsCount > 0) {
        throw new UnprocessableEntityException({
          message: 'No se puede editar una venta con pagos aplicados',
          payload: { code: 'SALE_HAS_PAYMENTS' },
        });
      }

      const patch: Partial<SaleInvoice> = {};

      // Customer (opcional).
      if (dto.customer_id !== undefined) {
        if (dto.customer_id === null) {
          patch.customer_id = null;
          patch.customer_name = null;
        } else {
          const customer = await manager.findOne(Customer, {
            where: {
              id: String(dto.customer_id),
              company_id: String(companyId),
              is_archived: false,
            },
          });
          if (!customer) {
            throw new UnprocessableEntityException('Cliente no encontrado o archivado');
          }
          patch.customer_id = customer.id;
          patch.customer_name = customer.name;
        }
      }

      if (dto.notes !== undefined) {
        patch.notes = dto.notes === null ? null : dto.notes?.trim() || null;
      }

      // Reemplazo de líneas.
      if (dto.lines) {
        const productIds = Array.from(new Set(dto.lines.map((l) => String(l.product_id))));
        const products = await manager.find(Product, {
          where: { id: In(productIds), company_id: String(companyId) },
        });
        if (products.length !== productIds.length) {
          throw new BadRequestException('Uno o más productos no existen');
        }
        const invalidProduct = products.find(
          (p) => p.product_type !== ProductType.SIMPLE || p.is_archived,
        );
        if (invalidProduct) {
          throw new BadRequestException(
            `El producto "${invalidProduct.name}" no es un producto simple disponible`,
          );
        }
        const productById = new Map(products.map((p) => [Number(p.id), p]));

        const packagingIds = Array.from(
          new Set(
            dto.lines
              .map((l) => l.packaging_id)
              .filter((idv): idv is number => typeof idv === 'number' && idv > 0)
              .map((idv) => String(idv)),
          ),
        );
        const packagingById = new Map<number, Packaging>();
        if (packagingIds.length > 0) {
          const packagings = await manager.find(Packaging, {
            where: {
              id: In(packagingIds),
              company_id: String(companyId),
              is_archived: false,
            },
          });
          if (packagings.length !== packagingIds.length) {
            throw new BadRequestException('Uno o más empaques no existen o están archivados');
          }
          for (const p of packagings) {
            packagingById.set(Number(p.id), p);
          }
        }

        const productPriceIds = Array.from(
          new Set(
            dto.lines
              .map((l) => l.product_price_id)
              .filter((idv): idv is number => typeof idv === 'number' && idv > 0)
              .map((idv) => String(idv)),
          ),
        );
        const productPriceById = new Map<number, ProductPrice>();
        if (productPriceIds.length > 0) {
          const prices = await manager.find(ProductPrice, {
            where: { id: In(productPriceIds), company_id: String(companyId) },
          });
          if (prices.length !== productPriceIds.length) {
            throw new BadRequestException('Uno o más niveles de precio no existen');
          }
          for (const p of prices) {
            productPriceById.set(Number(p.id), p);
          }
        }

        const totals = calculateSaleTotals(
          dto.lines,
          companyId,
          productById,
          packagingById,
          productPriceById,
        );

        // DELETE lines viejas + INSERT nuevas en la misma transacción.
        await manager.delete(SaleInvoiceLine, {
          sale_invoice_id: sale.id,
          company_id: String(companyId),
        });
        const lineRows = totals.lines.map((l) => ({ ...l, sale_invoice_id: sale.id }));
        await manager.insert(SaleInvoiceLine, lineRows);

        patch.subtotal = totals.subtotal;
        patch.tax_total = totals.tax_total;
        patch.total = totals.total;
        patch.cost = totals.cost;
        patch.profit = totals.profit;
        patch.margin = totals.margin;
      }

      if (Object.keys(patch).length > 0) {
        try {
          await manager.update(SaleInvoice, { id: sale.id, company_id: String(companyId) }, patch);
        } catch (error) {
          translateSaleConstraintError(error);
          throw error;
        }
      }

      this.logger.log({
        event: 'sale.updated',
        companyId,
        saleId: Number(sale.id),
        fieldsTouched: Object.keys(patch),
        actorId,
      });

      return this.loadAggregate(manager, Number(sale.id), companyId);
    });
  }

  private async loadAggregate(
    manager: EntityManager,
    saleId: number,
    companyId: number,
  ): Promise<SaleAggregate> {
    const reloaded = await manager.findOne(SaleInvoice, {
      where: { id: String(saleId), company_id: String(companyId) },
    });
    if (!reloaded) {
      throw new UnprocessableEntityException('Venta no encontrada tras actualizar');
    }
    const lines = await findSaleLines(manager, saleId, companyId);
    const payments = await findSalePayments(manager, saleId, companyId);
    const credit = await findSaleCredit(manager, saleId, companyId);
    return { sale: reloaded, lines, payments, credit };
  }
}
