import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import Big from 'big.js';
import { DataSource, In } from 'typeorm';

import { preciseNumber, toBig } from '@/common/utils/precision';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { Supplier } from '@/modules/suppliers/entities/supplier.entity';

import type { CreatePurchaseDto, CreatePurchaseLineDto } from '../dto/create-purchase.dto';
import { PurchaseCredit, PurchaseCreditStatus } from '../entities/purchase-credit.entity';
import { PurchaseLine } from '../entities/purchase-line.entity';
import { Purchase, PurchaseStatus } from '../entities/purchase.entity';
import { translatePurchaseConstraintError } from '../internal/constraint-errors';
import {
  findPurchaseCredit,
  findPurchaseLines,
  findPurchasePayments,
} from '../internal/purchase-lookups';
import { nextPurchaseNumber } from '../internal/purchase-number';
import type { PurchaseAggregate } from './find-purchase.action';

/**
 * Snapshot del actor (User u Employee) que crea la compra.
 */
export interface PurchaseCreator {
  id: number;
  fullName: string;
}

/**
 * Crea una compra atómicamente. Espejo de `POST /purchases` de PlacePos
 * (`purchases.routes.ts`).
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. Validar `supplier_id` pertenece a la company y NO está archivado.
 *      Cross-tenant guard: si el supplier es de otra company,
 *      `manager.findOne` devuelve `null` → 422 (mensaje PlacePos).
 *
 *   2. Validar TODOS los `product_id` de las líneas pertenecen a la company,
 *      están activos (`is_archived = false`) y son `SIMPLE` (no COMBO —
 *      PlacePos prohíbe comprar COMBOs).
 *
 *   3. Validar TODOS los `packaging_id` declarados pertenecen a la company
 *      y están activos. Si la línea declara `packaging_id` pero no es de la
 *      company → 422 (paridad con la validación de productos).
 *
 *   4. Generar `purchase_number` per-company bajo advisory lock (ver
 *      `internal/purchase-number.ts`). TODO(Fase 10): reemplazar por
 *      TicketSetting.
 *
 *   5. Calcular totales con Big.js:
 *        subtotal_linea   = packaging_qty * packaging_price
 *        iva_amount_linea = subtotal_linea * iva_rate / 100
 *        total_linea      = subtotal_linea + iva_amount_linea
 *        sumas en Big sin redondeo intermedio; redondeo final a scale 2.
 *      Rechaza líneas con `subtotal_linea <= 0` con mensaje literal de
 *      PlacePos.
 *
 *   6. INSERT `Purchase` con totales. INSERT batch de `PurchaseLine`.
 *
 *   7. INSERT `PurchaseCredit` con `total_amount = total`, `paid_amount = 0`,
 *      `balance = total`, `status = PENDING`. Cada compra nace con su credit
 *      (PlacePos lo hace siempre, no condicional).
 *
 *   8. Incrementar `Supplier.accumulated_debt` por el total. Espejo PlacePos
 *      (`manager.increment(Supplier, ...)`).
 *
 * Cualquier paso que falle → rollback completo. La constraint del UNIQUE
 * `(company_id, purchase_number)` es la red de seguridad si el lock
 * advisory no pudiera serializar (proceso externo bypass).
 *
 * NO actualizamos `Product.cost` con el último precio (PlacePos tampoco lo
 * hace en el route — esa lógica vive en otra capa). Si PlacePos lo agrega
 * en el futuro, se puede meter aquí dentro de la misma transacción.
 *
 * NO afecta `Product.stock` porque la columna no existe en esta fase del
 * API (Fase 3 la omitió). La recepción (`PUT /purchases/:id/receive`)
 * tampoco la toca — ver TODO en `mark-purchase-received.action.ts`.
 */
@Injectable()
export class CreatePurchaseAction {
  private readonly logger = new Logger(CreatePurchaseAction.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(
    dto: CreatePurchaseDto,
    companyId: number,
    createdBy: PurchaseCreator,
  ): Promise<PurchaseAggregate> {
    return this.dataSource.transaction<PurchaseAggregate>(async (manager) => {
      // 1. Supplier de la company y activo.
      const supplier = await manager.findOne(Supplier, {
        where: {
          id: String(dto.supplier_id),
          company_id: String(companyId),
          is_archived: false,
        },
      });
      if (!supplier) {
        throw new UnprocessableEntityException('Proveedor no encontrado o archivado');
      }

      // 2. Productos: cargar todos los referenciados en una sola query
      //    (filtrada por company_id — sin esto, fuga cross-tenant).
      const productIds = Array.from(new Set(dto.lines.map((l) => String(l.product_id))));
      const products = await manager.find(Product, {
        where: { id: In(productIds), company_id: String(companyId) },
      });
      if (products.length !== productIds.length) {
        // Algún product_id no existe en la company → mensaje literal PlacePos.
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

      // 3. Packagings: solo los que la línea declara explícitamente.
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

      // 4. Folio per-company atómico.
      const purchaseNumber = await nextPurchaseNumber(manager, companyId);

      // 5. Cálculo de totales con Big.js.
      let totalSubtotal: Big = toBig(0);
      let totalIva: Big = toBig(0);
      let totalGrand: Big = toBig(0);

      const linesData = dto.lines.map((line: CreatePurchaseLineDto) => {
        const product = productById.get(line.product_id);
        if (!product) {
          // Defensa: ya validamos arriba, pero el get retorna `undefined`
          // si el id no estaba en el set. Lanzar BadRequest mantiene paridad.
          throw new BadRequestException('Uno o más productos no existen');
        }

        const packagingQty = toBig(line.packaging_qty ?? 0);
        const packagingPrice = toBig(line.packaging_price ?? 0);
        const ivaRate = toBig(line.iva_rate ?? 0);

        const subtotal = packagingQty.times(packagingPrice);
        const ivaAmount = subtotal.times(ivaRate).div(100);
        const lineTotal = subtotal.plus(ivaAmount);

        if (subtotal.lte(0)) {
          throw new UnprocessableEntityException(
            `La línea "${product.name}" tiene un subtotal en cero. Verifica cantidad y precio.`,
          );
        }

        totalSubtotal = totalSubtotal.plus(subtotal);
        totalIva = totalIva.plus(ivaAmount);
        totalGrand = totalGrand.plus(lineTotal);

        // Resolver packaging si la línea lo trae.
        let packagingId: string | null = null;
        let packagingName: string | null = line.packaging_name ?? null;
        let packagingValue: number | null =
          line.packaging_value === null || line.packaging_value === undefined
            ? null
            : preciseNumber(toBig(line.packaging_value), 4);

        if (typeof line.packaging_id === 'number' && line.packaging_id > 0) {
          const packaging = packagingById.get(line.packaging_id);
          if (!packaging) {
            throw new BadRequestException('Uno o más empaques no existen o están archivados');
          }
          packagingId = String(packaging.id);
          packagingName = packagingName ?? packaging.name;
          if (packagingValue === null) {
            packagingValue = preciseNumber(toBig(packaging.value), 4);
          }
        } else if (product.packaging_id !== null && product.packaging_id !== undefined) {
          // Fallback PlacePos: si la línea no declara packaging, hereda del producto.
          packagingId = product.packaging_id;
        }

        return {
          company_id: String(companyId),
          product_id: String(product.id),
          supplier_id: String(dto.supplier_id),
          name: line.name?.trim() || product.name,
          packaging_id: packagingId,
          packaging_name: packagingName,
          packaging_value: packagingValue,
          packaging_qty: preciseNumber(packagingQty, 4),
          unit_qty: preciseNumber(toBig(line.unit_qty ?? 0), 4),
          unit_price: preciseNumber(toBig(line.unit_price ?? 0), 4),
          packaging_price: preciseNumber(packagingPrice, 2),
          iva_rate: preciseNumber(ivaRate, 2),
          subtotal: preciseNumber(subtotal, 2),
          iva_amount: preciseNumber(ivaAmount, 2),
          total: preciseNumber(lineTotal, 2),
        };
      });

      if (totalGrand.lte(0)) {
        throw new UnprocessableEntityException('El total de la compra debe ser mayor a cero');
      }

      const totalRounded = preciseNumber(totalGrand, 2);

      // 6. INSERT Purchase.
      const purchase = manager.create(Purchase, {
        company_id: String(companyId),
        purchase_number: purchaseNumber,
        supplier_id: String(dto.supplier_id),
        supplier_name: supplier.legal_name,
        subtotal: preciseNumber(totalSubtotal, 2),
        iva_total: preciseNumber(totalIva, 2),
        total: totalRounded,
        notes: dto.notes?.trim() || null,
        status: PurchaseStatus.PENDING,
        carrier_name: null,
        received_by: null,
        received_at: null,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
        is_deleted: false,
      });

      let savedPurchase: Purchase;
      try {
        savedPurchase = await manager.save(Purchase, purchase);
      } catch (error) {
        translatePurchaseConstraintError(error);
        throw error;
      }

      // 7. INSERT batch de líneas con el `purchase_id` ya conocido.
      const lineRows = linesData.map((l) => ({
        ...l,
        purchase_id: savedPurchase.id,
      }));
      await manager.insert(PurchaseLine, lineRows);

      // 8. INSERT PurchaseCredit.
      const credit = manager.create(PurchaseCredit, {
        company_id: String(companyId),
        purchase_id: savedPurchase.id,
        supplier_id: String(dto.supplier_id),
        total_amount: totalRounded,
        paid_amount: 0,
        balance: totalRounded,
        status: PurchaseCreditStatus.PENDING,
      });
      try {
        await manager.save(PurchaseCredit, credit);
      } catch (error) {
        translatePurchaseConstraintError(error);
        throw error;
      }

      // 9. Incrementar deuda acumulada del proveedor. Espejo PlacePos.
      await manager.increment(
        Supplier,
        { id: String(dto.supplier_id), company_id: String(companyId) },
        'accumulated_debt',
        totalRounded,
      );

      this.logger.log({
        event: 'purchase.created',
        companyId,
        purchaseId: Number(savedPurchase.id),
        purchaseNumber,
        supplierId: dto.supplier_id,
        total: totalRounded,
        actorId: createdBy.id,
      });

      // Cargamos el aggregate completo para devolverlo al controller.
      const lines = await findPurchaseLines(manager, Number(savedPurchase.id), companyId);
      const creditOut = await findPurchaseCredit(manager, Number(savedPurchase.id), companyId);
      const payments = await findPurchasePayments(manager, Number(savedPurchase.id), companyId);

      return { purchase: savedPurchase, lines, credit: creditOut, payments };
    });
  }
}
