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
import { Bank } from '@/modules/banks/entities/bank.entity';
import {
  CashRegisterLog,
  CashRegisterLogType,
} from '@/modules/cash-register/entities/cash-register-log.entity';
import {
  CashRegister,
  CashRegisterStatus,
} from '@/modules/cash-register/entities/cash-register.entity';
import { Customer } from '@/modules/customers/entities/customer.entity';
import {
  MovementConcept,
  MovementType,
} from '@/modules/financial-movements/entities/financial-movement.entity';
import { FinancialMovementsService } from '@/modules/financial-movements/financial-movements.service';
import { Packaging } from '@/modules/packagings/entities/packaging.entity';
import { Product, ProductType } from '@/modules/products/entities/product.entity';
import { SaleCredit, SaleCreditStatus } from '@/modules/sales/entities/sale-credit.entity';
import { SaleInvoiceLine } from '@/modules/sales/entities/sale-invoice-line.entity';
import { SaleInvoice, TicketType } from '@/modules/sales/entities/sale-invoice.entity';
import { SalePayment } from '@/modules/sales/entities/sale-payment.entity';
import { findSaleInCompany } from '@/modules/sales/internal/sale-lookups';
import { IncrementTicketNumberAction } from '@/modules/ticket-settings/actions/increment-ticket-number.action';
import { TicketSettingType } from '@/modules/ticket-settings/entities/ticket-setting.entity';
import { Wallet } from '@/modules/wallets/entities/wallet.entity';

import type { CreateCreditNoteDto, CreateCreditNoteLineDto } from '../dto/create-credit-note.dto';
import { CorrectionSource, type CorrectionSourceType } from '../entities/correction-source.entity';
import { CreditNoteLine } from '../entities/credit-note-line.entity';
import { CreditNote, NoteType, OperationType } from '../entities/credit-note.entity';
import { calculateNoteTotals } from '../internal/calculate-note-totals';
import { translateCreditNoteConstraintError } from '../internal/constraint-errors';
import {
  countActiveFullVoids,
  findNoteCorrectionSource,
  findNoteLines,
  sumPartialVoidedQuantitiesByLine,
} from '../internal/credit-note-lookups';
import type { CreditNoteAggregate } from './find-credit-note.action';

/**
 * Snapshot del actor (User u Employee) que crea la nota.
 */
export interface CreditNoteCreator {
  id: number;
  fullName: string;
}

/**
 * Combinaciones legales note_type x operation_type. Cualquier otra
 * combinación → 422 (defense in depth: el CHECK constraint también la
 * bloquea, pero validar en service da mensaje legible).
 */
const LEGAL_COMBINATIONS: ReadonlySet<string> = new Set([
  `${NoteType.CREDIT}|${OperationType.FULL_VOID}`,
  `${NoteType.CREDIT}|${OperationType.PARTIAL_VOID}`,
  `${NoteType.DEBIT}|${OperationType.ADDITION}`,
]);

/**
 * Crea una nota crédito o débito atómicamente. Espejo de los flujos
 * PlacePos `voidTicket` (FULL_VOID) y `editTicket` (PARTIAL_VOID +
 * ADDITION) — pero expuesto como un endpoint explícito `POST /credit-notes`
 * que el cliente CLOUD puede invocar.
 *
 * --------------------------------------------------------------------------
 * Pasos atómicos (UNA transacción)
 * --------------------------------------------------------------------------
 *
 *   1. Validar combinación note_type x operation_type. Inválida → 422.
 *
 *   2. Lock pessimistic_write sobre `SaleInvoice` + validar:
 *      - Pertenece a la company.
 *      - `ticket_type = SALE` (no se anula ORDER por nota — esa se
 *        soft-deletea directo).
 *      - `is_deleted = false`.
 *
 *   3. Lock pessimistic_write sobre `SaleCredit` (si existe). Necesario
 *      para ajustar `balance/paid_amount/status` sin race.
 *
 *   4. Validaciones específicas por operation_type:
 *      - FULL_VOID: chequear que no exista YA otra FULL_VOID activa →
 *        409 (`SALE_ALREADY_FULL_VOIDED`).
 *      - PARTIAL_VOID: para cada `original_line_id` declarada, la suma
 *        (notas previas + esta) no puede exceder la qty original. 422.
 *      - ADDITION: sin tope.
 *
 *   5. Calcular totales con Big.js:
 *      - FULL_VOID con lines vacías: total = sale.total (snapshot total).
 *      - FULL_VOID con lines: total = Σ líneas calculado.
 *      - PARTIAL_VOID / ADDITION: total = Σ líneas.
 *
 *   6. Folio atómico (`IncrementTicketNumberAction`):
 *      - CREDIT → TicketSettingType.CREDIT_NOTE.
 *      - DEBIT  → TicketSettingType.DEBIT_NOTE.
 *
 *   7. INSERT CreditNote + lines (si hay).
 *
 *   8. Side-effects financieros:
 *      a) Si FULL_VOID: reversar pagos (SalePayments existentes).
 *         Por cada pago no anulado:
 *           - bank/wallet → SELECT FOR UPDATE + UPDATE balance -= amount.
 *           - cash_register → si la caja del pago sigue abierta, log OUT
 *             CASH_OUT. Si está cerrada → 422 (no se puede revertir caja
 *             cerrada — el operador debe registrar la compensación
 *             manualmente).
 *           - FinancialMovement(EXPENSE, CREDIT_NOTE_REFUND).
 *         Generar correction_source = primer destino devuelto (bank/wallet/
 *         cash_register).
 *         Marcar la venta como `is_deleted = true`.
 *
 *      b) Si CREDIT (FULL_VOID o PARTIAL_VOID):
 *           - Si la venta tiene SaleCredit, ajustar:
 *               new_balance = balance - note.total
 *               new_status  = PAID si new_balance == 0, sino PARTIALLY_PAID
 *               Si new_balance < 0 (la nota excede la deuda): se considera
 *               sobrepago — el remanente queda como anticipo en
 *               Customer.balance (positivo). Para esta fase rechazamos
 *               con 422 (PlacePos lo prohíbe igual).
 *           - Customer.balance += note.total (la deuda se reduce → menos
 *             negativo, o positivo si era 0).
 *           - correction_source = 'sale_credit' si NO hubo reverse de
 *             pagos.
 *
 *      c) Si DEBIT (ADDITION):
 *           - Customer.balance -= note.total (la deuda aumenta).
 *           - Si la venta tiene SaleCredit, ajustar `balance += note.total`
 *             (los ADDITIONs aumentan la deuda asociada a la venta).
 *           - NO se toca caja. NO se crea correction_source.
 *
 *   9. INSERT CorrectionSource si aplica (FULL_VOID con reverse, o CREDIT
 *      con SaleCredit ajustado).
 *
 * Cualquier paso falla → rollback total.
 */
@Injectable()
export class CreateCreditNoteAction {
  private readonly logger = new Logger(CreateCreditNoteAction.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly incrementTicketNumberAction: IncrementTicketNumberAction,
    private readonly financialMovementsService: FinancialMovementsService,
  ) {}

  async execute(
    dto: CreateCreditNoteDto,
    companyId: number,
    createdBy: CreditNoteCreator,
  ): Promise<CreditNoteAggregate> {
    // 1. Combinación legal.
    this.assertLegalCombination(dto.note_type, dto.operation_type);

    return this.dataSource.transaction<CreditNoteAggregate>(async (manager) => {
      // 2. Lock + validación de la venta.
      const sale = await findSaleInCompany(manager, dto.sale_invoice_id, companyId, {
        requireActive: true,
        lock: true,
      });
      if (sale.ticket_type !== TicketType.SALE) {
        throw new UnprocessableEntityException({
          message: 'Solo se pueden generar notas sobre ventas confirmadas (SALE).',
          payload: { code: 'NOTE_REQUIRES_SALE_TICKET' },
        });
      }

      // 3. Cargar SaleCredit (si existe) con lock.
      const credit = await manager.findOne(SaleCredit, {
        where: { sale_invoice_id: sale.id, company_id: String(companyId) },
        lock: { mode: 'pessimistic_write' },
      });

      // 4. Validaciones específicas + carga de catálogo.
      let totals: ReturnType<typeof calculateNoteTotals> | null = null;
      let totalBig: Big;

      if (dto.operation_type === OperationType.FULL_VOID) {
        await this.assertNoExistingFullVoid(manager, Number(sale.id), companyId);

        if (dto.lines && dto.lines.length > 0) {
          totals = await this.computeLinesWithCatalog(manager, dto.lines, companyId, {
            requireOriginalLines: false,
            saleId: Number(sale.id),
          });
          totalBig = toBig(totals.total);
        } else {
          // FULL_VOID sin líneas: replicar total de la venta.
          totalBig = toBig(sale.total);
          if (totalBig.lte(0)) {
            throw new UnprocessableEntityException(
              'La venta original no tiene total positivo para anular.',
            );
          }
        }
      } else if (dto.operation_type === OperationType.PARTIAL_VOID) {
        if (!dto.lines || dto.lines.length === 0) {
          throw new BadRequestException('PARTIAL_VOID requiere al menos una línea.');
        }
        totals = await this.computeLinesWithCatalog(manager, dto.lines, companyId, {
          requireOriginalLines: true,
          saleId: Number(sale.id),
        });
        await this.assertPartialVoidQuantitiesValid(manager, Number(sale.id), companyId, dto.lines);
        totalBig = toBig(totals.total);
      } else {
        // ADDITION
        if (!dto.lines || dto.lines.length === 0) {
          throw new BadRequestException('ADDITION requiere al menos una línea.');
        }
        totals = await this.computeLinesWithCatalog(manager, dto.lines, companyId, {
          requireOriginalLines: false,
          saleId: Number(sale.id),
        });
        totalBig = toBig(totals.total);
      }

      // CREDIT contra SaleCredit: validar no sobrepago.
      if (dto.note_type === NoteType.CREDIT && credit && totalBig.gt(toBig(credit.balance))) {
        throw new UnprocessableEntityException({
          message: `La nota crédito (${totalBig.toFixed(2)}) excede el saldo pendiente del crédito (${credit.balance.toFixed(2)}).`,
          payload: { code: 'CREDIT_NOTE_EXCEEDS_BALANCE' },
        });
      }

      // 6. Folio atómico per-company.
      const ticketType =
        dto.note_type === NoteType.CREDIT
          ? TicketSettingType.CREDIT_NOTE
          : TicketSettingType.DEBIT_NOTE;
      const ticket = await this.incrementTicketNumberAction.execute(manager, companyId, ticketType);

      // 7. INSERT CreditNote (+ lines si aplica).
      const total = preciseNumber(totalBig, 2);
      const subtotal = totals ? totals.subtotal : total;
      const taxTotal = totals ? totals.tax_total : 0;

      const noteEntity = manager.create(CreditNote, {
        company_id: String(companyId),
        sale_invoice_id: sale.id,
        customer_id: sale.customer_id,
        note_number: ticket.formatted,
        note_type: dto.note_type,
        operation_type: dto.operation_type,
        subtotal,
        tax_total: taxTotal,
        total,
        reason: dto.reason?.trim() || null,
        created_by: createdBy.fullName,
        created_by_id: String(createdBy.id),
        is_deleted: false,
      });

      let savedNote: CreditNote;
      try {
        savedNote = await manager.save(CreditNote, noteEntity);
      } catch (error) {
        translateCreditNoteConstraintError(error);
        throw error;
      }

      if (totals) {
        const lineRows = totals.lines.map((l) => ({
          ...l,
          credit_note_id: savedNote.id,
        }));
        await manager.insert(CreditNoteLine, lineRows);
      }

      // 8. Side-effects financieros.
      let correctionSourceInput: {
        source_type: CorrectionSourceType;
        source_id: number;
        source_name: string;
      } | null = null;

      if (dto.operation_type === OperationType.FULL_VOID) {
        correctionSourceInput = await this.reverseSalePayments(
          manager,
          sale,
          companyId,
          ticket.formatted,
          createdBy,
        );
        // Marcar la venta como anulada.
        await manager.update(
          SaleInvoice,
          { id: sale.id, company_id: String(companyId) },
          { is_deleted: true },
        );
      }

      // CREDIT: ajustar SaleCredit + Customer.balance.
      if (dto.note_type === NoteType.CREDIT) {
        if (credit) {
          const newBalance = preciseNumber(toBig(credit.balance).minus(totalBig), 2);
          const newPaid = credit.paid_amount; // paid_amount no cambia (no se cobró).
          const newStatus =
            newBalance === 0 && Number(credit.paid_amount) === Number(credit.total_amount)
              ? SaleCreditStatus.PAID
              : newBalance === 0
                ? // SaleCredit reducido por una nota a 0 sin pago equivalente.
                  // PlacePos lo considera saldado por la nota; usamos PAID.
                  SaleCreditStatus.PAID
                : Number(newPaid) > 0
                  ? SaleCreditStatus.PARTIALLY_PAID
                  : SaleCreditStatus.PENDING;

          // El CHECK `paid_amount + balance = total_amount` exige reducir
          // también `total_amount` cuando la nota CREDIT reduce el balance
          // sin haber cobrado nada. PlacePos lo modela así: la nota
          // disminuye el "deber total" del crédito.
          const newTotalAmount = preciseNumber(toBig(credit.total_amount).minus(totalBig), 2);

          if (newTotalAmount < 0 || newBalance < 0) {
            throw new UnprocessableEntityException(
              'La nota crédito excede los importes del crédito asociado.',
            );
          }

          await manager.update(
            SaleCredit,
            { id: credit.id, company_id: String(companyId) },
            {
              total_amount: newTotalAmount,
              balance: newBalance,
              status: newStatus,
            },
          );

          // Si no hubo reverse de pagos (no FULL_VOID con SalePayments),
          // la fuente de corrección es el sale_credit.
          if (!correctionSourceInput) {
            correctionSourceInput = {
              source_type: 'sale_credit',
              source_id: Number(credit.id),
              source_name: `SaleCredit #${credit.id}`,
            };
          }
        }

        // Customer.balance += note.total (deuda se reduce; signed → menos
        // negativo).
        if (sale.customer_id !== null) {
          await manager.increment(
            Customer,
            { id: sale.customer_id, company_id: String(companyId) },
            'balance',
            total,
          );
        }
      } else {
        // DEBIT (ADDITION): aumentar SaleCredit (si existe) + Customer.balance
        // se reduce (más negativo).
        if (credit) {
          const newTotalAmount = preciseNumber(toBig(credit.total_amount).plus(totalBig), 2);
          const newBalance = preciseNumber(toBig(credit.balance).plus(totalBig), 2);
          const newStatus =
            newBalance === 0
              ? SaleCreditStatus.PAID
              : Number(credit.paid_amount) > 0
                ? SaleCreditStatus.PARTIALLY_PAID
                : SaleCreditStatus.PENDING;

          await manager.update(
            SaleCredit,
            { id: credit.id, company_id: String(companyId) },
            {
              total_amount: newTotalAmount,
              balance: newBalance,
              status: newStatus,
            },
          );
        }

        if (sale.customer_id !== null) {
          await manager.decrement(
            Customer,
            { id: sale.customer_id, company_id: String(companyId) },
            'balance',
            total,
          );
        }
      }

      // 9. INSERT CorrectionSource si aplica.
      if (correctionSourceInput) {
        const csEntity = manager.create(CorrectionSource, {
          company_id: String(companyId),
          credit_note_id: savedNote.id,
          source_type: correctionSourceInput.source_type,
          source_id: String(correctionSourceInput.source_id),
          source_name: correctionSourceInput.source_name,
          created_by: createdBy.fullName,
          created_by_id: String(createdBy.id),
        });
        try {
          await manager.save(CorrectionSource, csEntity);
        } catch (error) {
          translateCreditNoteConstraintError(error);
          throw error;
        }
      }

      this.logger.log({
        event: 'credit_note.created',
        companyId,
        noteId: Number(savedNote.id),
        noteNumber: ticket.formatted,
        noteType: dto.note_type,
        operationType: dto.operation_type,
        saleInvoiceId: Number(sale.id),
        total,
        actorId: createdBy.id,
      });

      return this.loadAggregate(manager, Number(savedNote.id), companyId);
    });
  }

  /**
   * Rechaza combinaciones inválidas (defense in depth — el CHECK constraint
   * también las bloquea pero el mensaje legible facilita debug).
   */
  private assertLegalCombination(noteType: NoteType, operationType: OperationType): void {
    if (!LEGAL_COMBINATIONS.has(`${noteType}|${operationType}`)) {
      throw new UnprocessableEntityException({
        message: `Combinación ilegal: note_type=${noteType} con operation_type=${operationType}.`,
        payload: { code: 'NOTE_TYPE_OPERATION_MISMATCH' },
      });
    }
  }

  private async assertNoExistingFullVoid(
    manager: EntityManager,
    saleId: number,
    companyId: number,
  ): Promise<void> {
    const existing = await countActiveFullVoids(manager, saleId, companyId);
    if (existing > 0) {
      throw new UnprocessableEntityException({
        message: 'Ya existe una anulación total activa para esta venta.',
        payload: { code: 'SALE_ALREADY_FULL_VOIDED' },
      });
    }
  }

  /**
   * Para PARTIAL_VOID: cada `original_line_id` declarado en `lines` no
   * puede acumular (notas previas + esta nota) más cantidad que la línea
   * original. Big.js para evitar drift.
   */
  private async assertPartialVoidQuantitiesValid(
    manager: EntityManager,
    saleId: number,
    companyId: number,
    requestedLines: CreateCreditNoteLineDto[],
  ): Promise<void> {
    const originalLineIds = Array.from(
      new Set(
        requestedLines
          .map((l) => l.original_line_id)
          .filter((id): id is number => typeof id === 'number' && id > 0),
      ),
    );
    if (originalLineIds.length === 0) {
      throw new UnprocessableEntityException(
        'PARTIAL_VOID requiere referenciar las líneas originales con original_line_id.',
      );
    }

    const originalLines = await manager.find(SaleInvoiceLine, {
      where: {
        id: In(originalLineIds.map((id) => String(id))),
        sale_invoice_id: String(saleId),
        company_id: String(companyId),
      },
    });
    if (originalLines.length !== originalLineIds.length) {
      throw new BadRequestException(
        'Una o más líneas originales no pertenecen a la venta indicada.',
      );
    }
    const originalById = new Map(originalLines.map((l) => [Number(l.id), l]));

    const previouslyVoided = await sumPartialVoidedQuantitiesByLine(manager, saleId, companyId);

    // Sumar cantidades por original_line_id en la solicitud actual.
    const requestedByLine = new Map<number, Big>();
    for (const line of requestedLines) {
      if (typeof line.original_line_id !== 'number' || line.original_line_id <= 0) {
        continue;
      }
      const prev = requestedByLine.get(line.original_line_id) ?? toBig(0);
      requestedByLine.set(line.original_line_id, prev.plus(toBig(line.quantity)));
    }

    for (const [originalLineId, requestedQty] of requestedByLine.entries()) {
      const original = originalById.get(originalLineId);
      if (!original) {
        continue;
      }
      const alreadyVoided = toBig(previouslyVoided.get(originalLineId) ?? 0);
      const available = toBig(original.quantity).minus(alreadyVoided);
      if (requestedQty.gt(available)) {
        throw new UnprocessableEntityException({
          message: `La cantidad a anular (${requestedQty.toFixed(4)}) excede lo disponible (${available.toFixed(4)}) en la línea ${originalLineId}.`,
          payload: { code: 'PARTIAL_VOID_EXCEEDS_ORIGINAL' },
        });
      }
    }
  }

  /**
   * Carga catálogo (Product / Packaging) para las líneas declaradas y
   * delega el cálculo de totales a `calculateNoteTotals`. Multi-tenant:
   * todos los ids deben pertenecer a la company.
   */
  private async computeLinesWithCatalog(
    manager: EntityManager,
    lines: CreateCreditNoteLineDto[],
    companyId: number,
    options: { requireOriginalLines: boolean; saleId: number },
  ): Promise<ReturnType<typeof calculateNoteTotals>> {
    // Productos.
    const productIds = Array.from(new Set(lines.map((l) => String(l.product_id))));
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
        `El producto "${invalidProduct.name}" no es un producto simple disponible.`,
      );
    }
    const productById = new Map(products.map((p) => [Number(p.id), p]));

    // Packagings (solo los referenciados).
    const packagingIds = Array.from(
      new Set(
        lines
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

    // original_line_id (si lo exige PARTIAL_VOID): validar que las líneas
    // pertenecen a la venta (la validación de qty disponible se hace en
    // assertPartialVoidQuantitiesValid).
    if (options.requireOriginalLines) {
      const originalIds = Array.from(
        new Set(
          lines
            .map((l) => l.original_line_id)
            .filter((id): id is number => typeof id === 'number' && id > 0)
            .map((id) => String(id)),
        ),
      );
      if (originalIds.length > 0) {
        const originals = await manager.find(SaleInvoiceLine, {
          where: {
            id: In(originalIds),
            sale_invoice_id: String(options.saleId),
            company_id: String(companyId),
          },
        });
        if (originals.length !== originalIds.length) {
          throw new BadRequestException(
            'Una o más líneas originales no pertenecen a la venta indicada.',
          );
        }
      }
    }

    return calculateNoteTotals(lines, companyId, productById, packagingById);
  }

  /**
   * Reversa los pagos de una venta para FULL_VOID. Por cada SalePayment
   * activo:
   *   - bank/wallet: lock + decrementar balance.
   *   - cash_register: si la caja del pago sigue abierta, log OUT CASH_OUT.
   *     Si está cerrada → 422 (operador debe compensar manualmente).
   *
   * Registra `FinancialMovement(EXPENSE, CREDIT_NOTE_REFUND)` por cada
   * reverse. Devuelve el primer destino para usar como `correction_source`
   * de la nota (PlacePos guarda una fuente representativa).
   */
  private async reverseSalePayments(
    manager: EntityManager,
    sale: SaleInvoice,
    companyId: number,
    noteNumber: string,
    actor: CreditNoteCreator,
  ): Promise<{ source_type: CorrectionSourceType; source_id: number; source_name: string } | null> {
    const payments = await manager.find(SalePayment, {
      where: { sale_invoice_id: sale.id, company_id: String(companyId) },
      order: { created_at: 'ASC' },
    });
    if (payments.length === 0) {
      return null;
    }

    let firstSource: {
      source_type: CorrectionSourceType;
      source_id: number;
      source_name: string;
    } | null = null;

    for (const payment of payments) {
      // HIGH-2 auditoría: para cash el balance neto de la caja recibió
      // `amount - change_amount` (cliente entregó X, se le devolvió vuelto).
      // Si revertimos `amount` completo, sacamos más de lo que entró y la
      // caja queda descuadrada. Solo aplica a cash: en bank/wallet no hay
      // vuelto (transferencia es por monto exacto).
      const changeBig = toBig(payment.change_amount ?? 0);
      const cashNetBig = toBig(payment.amount).minus(changeBig);
      const amountBig =
        payment.account_type === 'cash_register' ? cashNetBig : toBig(payment.amount);
      const amount = preciseNumber(amountBig, 2);

      if (payment.account_type === 'bank') {
        const bank = await manager.findOne(Bank, {
          where: {
            id: payment.account_id,
            company_id: String(companyId),
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!bank) {
          throw new NotFoundException('Cuenta bancaria asociada al pago original no encontrada.');
        }
        const newBalance = preciseNumber(toBig(bank.balance).minus(amountBig), 2);
        if (newBalance < 0) {
          throw new UnprocessableEntityException({
            message: `No hay saldo suficiente en el banco "${bank.name}" para revertir el pago original.`,
            payload: { code: 'BANK_INSUFFICIENT_FOR_REFUND' },
          });
        }
        await manager.update(
          Bank,
          { id: bank.id, company_id: String(companyId) },
          { balance: newBalance },
        );
        firstSource ??= {
          source_type: 'bank',
          source_id: Number(bank.id),
          source_name: bank.name,
        };
      } else if (payment.account_type === 'wallet') {
        const wallet = await manager.findOne(Wallet, {
          where: {
            id: payment.account_id,
            company_id: String(companyId),
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!wallet) {
          throw new NotFoundException('Billetera asociada al pago original no encontrada.');
        }
        const newBalance = preciseNumber(toBig(wallet.balance).minus(amountBig), 2);
        if (newBalance < 0) {
          throw new UnprocessableEntityException({
            message: `No hay saldo suficiente en la billetera "${wallet.name}" para revertir el pago original.`,
            payload: { code: 'WALLET_INSUFFICIENT_FOR_REFUND' },
          });
        }
        await manager.update(
          Wallet,
          { id: wallet.id, company_id: String(companyId) },
          { balance: newBalance },
        );
        firstSource ??= {
          source_type: 'wallet',
          source_id: Number(wallet.id),
          source_name: wallet.name,
        };
      } else {
        // cash_register: solo se puede revertir si la caja sigue abierta.
        const open = await manager.findOne(CashRegister, {
          where: {
            company_id: String(companyId),
            status: CashRegisterStatus.OPEN,
          },
          lock: { mode: 'pessimistic_write' },
        });
        if (!open) {
          throw new UnprocessableEntityException({
            message:
              'No hay caja abierta para revertir el pago en efectivo. Registra la devolución manualmente.',
            payload: { code: 'CASH_REGISTER_CLOSED_FOR_REFUND' },
          });
        }
        const log = manager.create(CashRegisterLog, {
          company_id: String(companyId),
          cash_register_id: open.id,
          type: CashRegisterLogType.CASH_OUT,
          direction: 'OUT',
          amount,
          affects_balance: true,
          description: `Reverso por anulación ${noteNumber}`,
          created_by: actor.fullName,
          created_by_id: String(actor.id),
        });
        await manager.save(CashRegisterLog, log);
        firstSource ??= {
          source_type: 'cash_register',
          source_id: Number(open.id),
          source_name: `Caja #${open.id}`,
        };
      }

      // FinancialMovement de reverso. source = cuenta interna que devuelve.
      // CRIT-1 auditoría: el CHECK `chk_financial_movements_destination_consistency`
      // exige destination_type y destination_id ambos NULL o ambos NOT NULL.
      // Si la venta tiene customer, se usa el customer_id como destination_id
      // (semántica: el dinero vuelve al cliente). Si NO hay customer (venta
      // mostrador), omitimos el lado destination — el movement queda solo con
      // source (el CHECK `chk_financial_movements_has_endpoint` se satisface).
      const destinationFields =
        sale.customer_id !== null
          ? { destination_type: 'external' as const, destination_id: Number(sale.customer_id) }
          : { destination_type: null, destination_id: null };
      await this.financialMovementsService.record(manager, {
        companyId,
        amount,
        movement_type: MovementType.EXPENSE,
        concept: MovementConcept.CREDIT_NOTE_REFUND,
        description: `Reverso de pago por nota ${noteNumber}`,
        source_type: payment.account_type,
        source_id: Number(payment.account_id),
        ...destinationFields,
        reference_code: `NOTE-${noteNumber}`,
        created_by: actor.fullName,
        created_by_id: actor.id,
      });
    }

    return firstSource;
  }

  private async loadAggregate(
    manager: EntityManager,
    noteId: number,
    companyId: number,
  ): Promise<CreditNoteAggregate> {
    const note = await manager.findOne(CreditNote, {
      where: { id: String(noteId), company_id: String(companyId) },
    });
    if (!note) {
      throw new NotFoundException('Nota no encontrada tras creación');
    }
    const lines = await findNoteLines(manager, noteId, companyId);
    const correctionSource = await findNoteCorrectionSource(manager, noteId, companyId);
    return { note, lines, correction_source: correctionSource };
  }
}
