import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, In, type EntityManager } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { ProductPrice } from '@/modules/products/entities/product-price.entity';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import type { CreateSaleDto, CreateSalePaymentInlineDto } from '../dto/create-sale.dto';
import { SaleCredit, SaleCreditStatus } from '../entities/sale-credit.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { applySalePayment, type SalePaymentActor } from '../internal/apply-sale-payment';
import { calculateSaleTotals } from '../internal/calculate-sale-totals';
import { translateSaleConstraintError } from '../internal/constraint-errors';
import { findSaleCredit, findSaleLines, findSalePayments } from '../internal/sale-lookups';
import type { SaleAggregate } from './find-sale.action';

/**
 * Snapshot del actor (User u Employee) que crea la venta.
 */
export interface SaleCreator {
  id: number;
  fullName: string;
}

/**
 * Crea una venta atómicamente. Espejo de `POST /sales` de PlacePos
 * (`sales.routes.ts → createOrder`).
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. (Opcional) Validar `customer_id` pertenece a la company (no archivado).
 *      Lock pessimistic_write sobre el customer si se va a tocar su
 *      `balance` (sale a crédito).
 *
 *   2. Validar TODOS los `product_id` de las líneas pertenecen a la company,
 *      son SIMPLE y NO están archivados.
 *
 *   3. Validar TODOS los `packaging_id` declarados pertenecen a la company.
 *
 *   4. Validar TODOS los `product_price_id` declarados pertenecen a la
 *      company Y al producto que la línea referencia.
 *
 *   5. Calcular totales con Big.js (`calculateSaleTotals`). El cliente
 *      puede enviar `total` como hint pero el service lo IGNORA — fuente
 *      única de verdad.
 *
 *   6. Generar `ticket_number` con `IncrementTicketNumberAction` para
 *      ticket_type `ORDER` (PlacePos siempre crea como ORDER).
 *
 *   7. INSERT `SaleInvoice` + batch INSERT de `SaleInvoiceLine`.
 *
 *   8. Si el DTO trae `payments[]`, por cada uno:
 *      - Idempotency uuid (devuelve el row existente si ya procesado).
 *      - Acreditar la cuenta receptora (bank/wallet con FOR UPDATE;
 *        cash_register con CashRegisterLog IN).
 *      - INSERT SalePayment.
 *      - INSERT FinancialMovement(INCOME, SALE).
 *
 *   9. Si `Σ payments < total`:
 *      - REQUIERE `customer_id`. Si la venta es mostrador (sin customer)
 *        rechazar 422.
 *      - INSERT SaleCredit con balance = total - paidSum,
 *        status = PARTIALLY_PAID (si paidSum > 0) o PENDING (si paidSum = 0).
 *      - DECREMENTAR `Customer.balance` por `balance` (signed: el cliente
 *        queda debiendo). Espejo PlacePos.
 *
 *  10. (Si `Σ payments > total` → rechazar 422.)
 *
 * Cualquier paso falla → rollback total.
 *
 * NO actualizamos stock de productos porque la columna `Product.stock` no
 * existe aún en este API (Fase 3 lo omitió). El TODO se mantiene en sync
 * con PlacePos cuando se añada.
 */
@Injectable()
export class CreateSaleAction {
  private readonly logger = new Logger(CreateSaleAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly incrementTicketNumberAction: IncrementTicketNumberAction,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: CreateSaleDto,
    companyId: number,
    createdBy: SaleCreator,
  ): Promise<SaleAggregate> {
    return this.dataSource.transaction<SaleAggregate>(async (manager) => {
      // 1. Customer (opcional). Si viene, validar + (lock si va a crédito).
      let customer: Customer | null = null;
      if (typeof dto.customer_id === 'number' && dto.customer_id > 0) {
        customer = await manager.findOne(Customer, {
          where: {
            id: String(dto.customer_id),
            company_id: String(companyId),
            is_archived: false,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!customer) {
          throw new UnprocessableEntityException('Cliente no encontrado o archivado');
        }
      }

      // 2. Productos.
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

      // 3. Packagings (solo los referenciados).
      const packagingIds = Array.from(
        new Set(
          dto.lines
            .map((l) => l.packaging_id)
            .filter((id): id is number => typeof id === 'number' && id > 0)
            .map((id) => String(id)),
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

      // 4. ProductPrices (solo los referenciados).
      const productPriceIds = Array.from(
        new Set(
          dto.lines
            .map((l) => l.product_price_id)
            .filter((id): id is number => typeof id === 'number' && id > 0)
            .map((id) => String(id)),
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

      // 5. Cálculo de totales con Big.js.
      const totals = calculateSaleTotals(
        dto.lines,
        companyId,
        productById,
        packagingById,
        productPriceById,
      );

      // 6. Folio ORDER per-company (atómico).
      const ticket = await this.incrementTicketNumberAction.execute(
        manager,
        companyId,
        TicketSettingType.ORDER,
      );

      // 7. INSERT SaleInvoice + lines.
      const saleEntity = manager.create(SaleInvoice, {
        company_id: String(companyId),
        ticket_type: TicketType.ORDER,
        ticket_number: ticket.formatted,
        sale_number: null,
        customer_id: customer ? customer.id : null,
        customer_name: customer ? customer.name : null,
        subtotal: totals.subtotal,
        tax_total: totals.tax_total,
        total: totals.total,
        cost: totals.cost,
        profit: totals.profit,
        margin: totals.margin,
        notes: dto.notes?.trim() || null,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
        is_deleted: false,
      });

      let savedSale: SaleInvoice;
      try {
        savedSale = await manager.save(SaleInvoice, saleEntity);
      } catch (error) {
        translateSaleConstraintError(error);
        throw error;
      }

      const lineRows = totals.lines.map((l) => ({
        ...l,
        sale_invoice_id: savedSale.id,
      }));
      await manager.insert(SaleInvoiceLine, lineRows);

      // 8. Pagos inline (opcional).
      const paymentsInput: CreateSalePaymentInlineDto[] = dto.payments ?? [];
      let paidSum: Big = toBig(0);
      const ticketReference = ticket.formatted;
      const actor: SalePaymentActor = { id: createdBy.id, fullName: createdBy.fullName };
      for (const p of paymentsInput) {
        const result = await applySalePayment(manager, this.financialMovementsService, {
          saleId: Number(savedSale.id),
          companyId,
          ticketReference,
          // CRIT-1 auditoría: propagar customer_id para el CHECK del FM.
          customerId: dto.customer_id ?? null,
          account_type: p.account_type,
          account_id: p.account_id,
          amount: p.amount,
          change_amount: p.change_amount,
          uuid: p.uuid ?? null,
          actor,
        });
        if (!result.idempotent) {
          paidSum = paidSum.plus(toBig(p.amount));
        } else {
          // Idempotente: el row preexistente ya cuenta — sumamos su amount real
          // (el cliente puede haber enviado un monto distinto al ya procesado;
          // confiamos en el registro persistido).
          paidSum = paidSum.plus(toBig(result.payment.amount));
        }
      }

      const totalBig = toBig(totals.total);
      if (paidSum.gt(totalBig)) {
        throw new UnprocessableEntityException(
          `La suma de pagos excede el total de la venta (${totalBig.toFixed(2)})`,
        );
      }

      // 9. SaleCredit si quedó saldo pendiente.
      const balanceBig = totalBig.minus(paidSum);
      if (balanceBig.gt(0)) {
        if (!customer) {
          throw new UnprocessableEntityException(
            'No se puede dejar saldo pendiente en una venta sin cliente identificado',
          );
        }
        await this.createSaleCredit(
          manager,
          savedSale,
          customer,
          totals.total,
          preciseNumber(paidSum, 2),
          preciseNumber(balanceBig, 2),
          dto.due_date,
          companyId,
        );
      }

      this.logger.log({
        event: 'sale.created',
        companyId,
        saleId: Number(savedSale.id),
        ticketNumber: ticket.formatted,
        customerId: customer ? Number(customer.id) : null,
        total: totals.total,
        paid: preciseNumber(paidSum, 2),
        balance: preciseNumber(balanceBig, 2),
        actorId: createdBy.id,
      });

      return this.loadAggregate(manager, Number(savedSale.id), companyId);
    });
  }

  /**
   * INSERT del SaleCredit + actualización de Customer.balance (signed).
   *
   * Convención PlacePos: `Customer.balance` SIGNED.
   *   - balance > 0 → la company le debe al cliente.
   *   - balance < 0 → el cliente debe a la company.
   *
   * Al crear una venta a crédito, RESTAMOS el balance del customer por el
   * monto pendiente (negativo más => cliente debe más).
   */
  private async createSaleCredit(
    manager: EntityManager,
    sale: SaleInvoice,
    customer: Customer,
    total: number,
    paidAmount: number,
    balance: number,
    dueDate: string | undefined,
    companyId: number,
  ): Promise<void> {
    const status = paidAmount > 0 ? SaleCreditStatus.PARTIALLY_PAID : SaleCreditStatus.PENDING;
    const credit = manager.create(SaleCredit, {
      company_id: String(companyId),
      sale_invoice_id: sale.id,
      customer_id: customer.id,
      total_amount: total,
      paid_amount: paidAmount,
      balance,
      due_date: dueDate ? new Date(dueDate) : null,
      status,
    });
    try {
      await manager.save(SaleCredit, credit);
    } catch (error) {
      translateSaleConstraintError(error);
      throw error;
    }

    // Customer.balance -= balance (cliente queda debiendo más).
    await manager.decrement(
      Customer,
      { id: customer.id, company_id: String(companyId) },
      'balance',
      balance,
    );
  }

  private async loadAggregate(
    manager: EntityManager,
    saleId: number,
    companyId: number,
  ): Promise<SaleAggregate> {
    const sale = await manager.findOne(SaleInvoice, {
      where: { id: String(saleId), company_id: String(companyId) },
    });
    if (!sale) {
      throw new NotFoundException('Venta no encontrada');
    }
    const lines = await findSaleLines(manager, saleId, companyId);
    const payments = await findSalePayments(manager, saleId, companyId);
    const credit = await findSaleCredit(manager, saleId, companyId);
    return { sale, lines, payments, credit };
  }
}
