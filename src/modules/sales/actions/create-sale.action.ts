import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, In, type EntityManager } from 'typeorm';

import { toBig } from '@/common/utils/precision';
import { Customer } from '@/modules/customers/entities/customer.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';

import type {
  CreateSaleDto,
  CreateSaleLineDto,
  CreateSalePaymentInlineDto,
} from '../dto/create-sale.dto';
import { SaleCredit, SaleCreditStatus } from '../entities/sale-credit.entity';
import { SaleInvoiceLine } from '../entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '../entities/sale-invoice.entity';
import { applySalePayment, type SalePaymentActor } from '../internal/apply-sale-payment';
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
 * Contrato del payload
 * --------------------------------------------------------------------------
 *
 * El cliente PlacePos envía exactamente `SaleInvoicePayload`:
 *
 *   items: [{ item_id, name, cost, price, quantity, total, profit, margin,
 *             price_mode, price_position }]
 *   total, cost, profit, margin       (pre-calculados con Big.js en el cliente)
 *   customer_id?, customer_name?      (mostrador → null/omit)
 *   ticket_type?                       (siempre ORDER al crear)
 *
 * El service confía en los totales del cliente — paridad estricta con
 * `saleOperations.createOrder` del modo servidor/cliente. La extensión cloud
 * son las validaciones multi-tenant antes del INSERT.
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. (Opcional) Validar `customer_id` pertenece a la company (no archivado).
 *      Lock pessimistic_write sobre el customer si va a quedar saldo.
 *
 *   2. Validar TODOS los `item_id` de las líneas pertenecen a la company,
 *      son SIMPLE y NO están archivados.
 *
 *   3. Generar `ticket_number` con `IncrementTicketNumberAction` para
 *      ticket_type ORDER (paridad PlacePos).
 *
 *   4. INSERT `SaleInvoice` con los totales del payload + multi-tenancy.
 *
 *   5. INSERT batch de `SaleInvoiceLine` mapeando los items del payload a la
 *      entidad cloud (campos pre-existentes IVA/packaging/product_price se
 *      persisten con valores neutros: el local no maneja esos conceptos).
 *
 *   6. Si el DTO trae `payments[]` (el cliente PlacePos no los envía al crear
 *      ORDER, pero el endpoint los soporta para futuro), procesar cada uno
 *      con `applySalePayment` (idempotente por uuid). Si Σ payments < total
 *      y hay customer_id, INSERT `SaleCredit` y decrementar
 *      `Customer.balance`. Si Σ payments > total → 422.
 *
 * Cualquier paso falla → rollback total.
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
      // 1. Customer (opcional). Si viene, validar + lock.
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

      // 2. Productos: validar que cada item_id pertenezca a la company y sea
      // SIMPLE no archivado. Cross-tenant guard crítico — sin esto un usuario
      // podría facturar productos de otra company.
      const productIds = Array.from(new Set(dto.items.map((l) => String(l.item_id))));
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

      // 3. Folio ORDER per-company (atómico).
      const ticket = await this.incrementTicketNumberAction.execute(
        manager,
        companyId,
        TicketSettingType.ORDER,
      );

      // 4. INSERT SaleInvoice con los totales del payload. El cliente PlacePos
      // los pre-calcula con Big.js; el service los persiste tal cual (paridad
      // con `saleOperations.createOrder`). `subtotal = total` y `tax_total = 0`
      // porque el modo servidor/cliente no maneja IVA en ventas.
      const saleEntity = manager.create(SaleInvoice, {
        company_id: String(companyId),
        ticket_type: TicketType.ORDER,
        ticket_number: ticket.formatted,
        sale_number: null,
        customer_id: customer ? customer.id : null,
        // Snapshot del nombre tal como llegó del cliente (paridad con
        // `saleOperations.createOrder`: persiste payload.customer_name ?? null
        // sin tocar el customer.name del BD).
        customer_name: dto.customer_name ?? null,
        subtotal: dto.total,
        tax_total: 0,
        total: dto.total,
        cost: dto.cost,
        profit: dto.profit,
        margin: dto.margin,
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

      // 5. Mapear y persistir las líneas. Los campos cloud-only sin equivalente
      // en el payload local quedan en su default neutro: `subtotal = total`,
      // `iva_percentage = 0`, `iva_amount = 0`, `packaging_id = null`,
      // `product_price_id = null`. La columna `description` recibe el `name`
      // (snapshot del producto).
      const lineRows = dto.items.map((item) => mapItemToLineRow(item, savedSale.id, companyId));
      await manager.insert(SaleInvoiceLine, lineRows);

      // 6. Pagos inline (opcional — PlacePos no los envía al crear ORDER).
      const paymentsInput: CreateSalePaymentInlineDto[] = dto.payments ?? [];
      let paidSum: Big = toBig(0);
      const ticketReference = ticket.formatted;
      const actor: SalePaymentActor = { id: createdBy.id, fullName: createdBy.fullName };
      for (const p of paymentsInput) {
        const result = await applySalePayment(manager, this.financialMovementsService, {
          saleId: Number(savedSale.id),
          companyId,
          ticketReference,
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
          paidSum = paidSum.plus(toBig(result.payment.amount));
        }
      }

      const totalBig = toBig(dto.total);
      if (paidSum.gt(totalBig)) {
        throw new UnprocessableEntityException(
          `La suma de pagos excede el total de la venta (${totalBig.toFixed(2)})`,
        );
      }

      const balanceBig = totalBig.minus(paidSum);
      if (balanceBig.gt(0) && paymentsInput.length > 0) {
        // Solo creamos SaleCredit si se aplicaron pagos parciales. Si no
        // vinieron pagos (caso PlacePos al crear ORDER), la venta queda sin
        // crédito — el saldo se gestiona al cobrar vía POST /payments.
        if (!customer) {
          throw new UnprocessableEntityException(
            'No se puede dejar saldo pendiente en una venta sin cliente identificado',
          );
        }
        await this.createSaleCredit(
          manager,
          savedSale,
          customer,
          dto.total,
          Number(paidSum.toFixed(2)),
          Number(balanceBig.toFixed(2)),
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
        total: dto.total,
        paid: Number(paidSum.toFixed(2)),
        balance: Number(balanceBig.toFixed(2)),
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
    // Una venta recién creada nunca tiene NC/ND, pero el shape del aggregate
    // las exige para mantener el contrato del DTO uniforme.
    return { sale, lines, payments, credit, creditNotes: [] };
  }
}

/**
 * Mapea un item del payload PlacePos a la fila lista para INSERT en
 * `sale_invoice_lines`. Los campos cloud-only sin equivalente en el shape
 * local (`packaging_id`, `product_price_id`, `iva_percentage`, `iva_amount`)
 * quedan en su valor neutro — el modo servidor/cliente no maneja esos
 * conceptos en ventas.
 */
function mapItemToLineRow(item: CreateSaleLineDto, saleInvoiceId: string, companyId: number) {
  const unitCost = item.cost;
  const lineTotal = item.total;
  return {
    company_id: String(companyId),
    sale_invoice_id: saleInvoiceId,
    product_id: String(item.item_id),
    packaging_id: null as string | null,
    product_price_id: null as string | null,
    description: item.name,
    quantity: item.quantity,
    unit_price: item.price,
    unit_cost: unitCost,
    subtotal: lineTotal,
    iva_percentage: 0,
    iva_amount: 0,
    total: lineTotal,
    profit: item.profit,
    margin: item.margin,
  };
}
