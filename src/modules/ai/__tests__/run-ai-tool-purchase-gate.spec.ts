import type { DataSource } from 'typeorm';

import type { DashboardService } from '@/modules/dashboard/dashboard.service';
import type { TreasuryService } from '@/modules/treasury/treasury.service';

import type { RunAiExpenseToolAction } from '../actions/run-ai-expense-tool.action';
import type { RunAiPurchaseToolAction } from '../actions/run-ai-purchase-tool.action';
import type { RunAiSaleToolAction } from '../actions/run-ai-sale-tool.action';
import { RunAiToolAction } from '../actions/run-ai-tool.action';
import type { RunAiTreasuryToolAction } from '../actions/run-ai-treasury-tool.action';
import type { AiToolRequestContext } from '../internal/expense-tool-helpers';
import { declarationsFor, toolSummariesFor, type AiToolActor } from '../internal/tool-catalog';

/**
 * Crear compras escribe deuda con el proveedor: aunque el modelo "alucine" la
 * llamada, solo el dueño o el rol Administrador CON permiso de Compras llegan a
 * ejecutarla. Cruzar un documento con el inventario es lectura: basta el
 * permiso de Inventario.
 */
describe('RunAiToolAction · gate de las herramientas de compras', () => {
  const CONTEXT: AiToolRequestContext = {
    request_id: '00000000-0000-4000-8000-000000000004',
    current_user_message: 'sí',
    previous_user_message: 'crea la compra con esta factura',
  };

  const build = (): {
    action: RunAiToolAction;
    purchaseTools: Record<string, jest.Mock>;
    query: jest.Mock;
  } => {
    const purchaseTools = {
      matchDocumentProducts: jest.fn().mockResolvedValue({ count: 1, items: [] }),
      preparePurchase: jest.fn().mockResolvedValue({
        status: 'confirmation_required',
        summary: { total: 1000, lines: [] },
      }),
      confirmPurchase: jest.fn().mockResolvedValue({
        status: 'executed',
        purchase: { purchase_id: 5, purchase_number: 'C-5', total: 1000 },
      }),
    };
    const query = jest.fn();
    const action = new RunAiToolAction(
      { query } as unknown as DataSource,
      {} as unknown as DashboardService,
      {} as unknown as TreasuryService,
      {} as unknown as RunAiExpenseToolAction,
      {} as unknown as RunAiSaleToolAction,
      {} as unknown as RunAiTreasuryToolAction,
      purchaseTools as unknown as RunAiPurchaseToolAction,
    );
    return { action, purchaseTools, query };
  };

  const actor = (over: Partial<AiToolActor> = {}): AiToolActor => ({
    isAdmin: false,
    permissions: new Set<string>(['canAccessPurchase', 'canAccessInventory']),
    canViewProfit: true,
    userId: 9,
    is_administrator: false,
    ...over,
  });

  it.each(['prepare_purchase', 'confirm_purchase'])(
    'un empleado con permiso de Compras pero sin rol Administrador NO ejecuta %s',
    async (name) => {
      const { action, purchaseTools, query } = build();
      const execution = await action.execute(13, actor(), name, { supplier: 'X' }, CONTEXT);
      expect(execution.ok).toBe(false);
      expect(execution.response.error).toMatch(/no tiene permiso/);
      for (const fn of Object.values(purchaseTools)) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('el rol Administrador SIN permiso de Compras tampoco la ejecuta', async () => {
    const { action, purchaseTools } = build();
    const execution = await action.execute(
      13,
      actor({ is_administrator: true, permissions: new Set(['canAccessInventory']) }),
      'prepare_purchase',
      {},
      CONTEXT,
    );
    expect(execution.ok).toBe(false);
    expect(purchaseTools.preparePurchase).not.toHaveBeenCalled();
  });

  it('el rol Administrador con Compras prepara y confirma, con tarjetas del servidor', async () => {
    const { action, purchaseTools } = build();
    const admin = actor({ is_administrator: true });
    const args = { supplier: 'Distribuidora', lines: [] };

    const prepared = await action.execute(13, admin, 'prepare_purchase', args, CONTEXT);
    expect(prepared.ok).toBe(true);
    expect(prepared.card).toEqual({ kind: 'purchase_preview', data: { total: 1000, lines: [] } });
    expect(purchaseTools.preparePurchase).toHaveBeenCalledWith(13, admin, args, CONTEXT);

    // Los argumentos que mande el modelo a la confirmación se ignoran.
    const confirmed = await action.execute(13, admin, 'confirm_purchase', { total: 1 }, CONTEXT);
    expect(purchaseTools.confirmPurchase).toHaveBeenCalledWith(13, admin, CONTEXT);
    expect(confirmed.card).toEqual({
      kind: 'purchase_created',
      data: { purchase_id: 5, purchase_number: 'C-5', total: 1000 },
    });
  });

  it('match_document_products exige Inventario, no Compras ni rol', async () => {
    const { action, purchaseTools } = build();
    const denied = await action.execute(
      13,
      actor({ permissions: new Set(['canAccessPurchase']) }),
      'match_document_products',
      { items: [] },
      CONTEXT,
    );
    expect(denied.ok).toBe(false);

    const cashier = actor({ permissions: new Set(['canAccessInventory']) });
    const allowed = await action.execute(
      13,
      cashier,
      'match_document_products',
      { items: [] },
      CONTEXT,
    );
    expect(allowed.ok).toBe(true);
    expect(purchaseTools.matchDocumentProducts).toHaveBeenCalledWith(13, { items: [] });
  });

  it('al empleado sin rol ni siquiera se le declaran las de compras', () => {
    const names = declarationsFor(actor()).map((tool) => tool.name);
    expect(names).toContain('match_document_products');
    expect(names).not.toContain('prepare_purchase');
    expect(names).not.toContain('confirm_purchase');

    const admin_names = declarationsFor(actor({ is_administrator: true })).map((t) => t.name);
    expect(admin_names).toEqual(expect.arrayContaining(['prepare_purchase', 'confirm_purchase']));
    // confirm_purchase es un paso interno: no se lista como capacidad.
    const listed = toolSummariesFor(actor({ is_administrator: true })).map((t) => t.name);
    expect(listed).toContain('prepare_purchase');
    expect(listed).not.toContain('confirm_purchase');
  });

  it('las herramientas de compras nunca aceptan business_id (solo el negocio actual)', () => {
    const owner = actor({
      isAdmin: true,
      businesses: [
        { id: 13, name: 'Principal', is_branch: false, is_active: true },
        { id: 14, name: 'Sucursal', is_branch: true, is_active: true },
      ],
    });
    const declarations = declarationsFor(owner);
    for (const name of ['prepare_purchase', 'confirm_purchase']) {
      const declaration = declarations.find((tool) => tool.name === name);
      expect(declaration?.parameters?.properties).not.toHaveProperty('business_id');
    }
  });
});
