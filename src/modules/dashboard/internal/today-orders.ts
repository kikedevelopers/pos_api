import { toBig } from '@/common/utils/precision';

import { round2 } from './aggregations';

/**
 * Totales del resumen del día (`GET /dashboard/today`) bajo el flag
 * `include_orders_in_reports`.
 *
 * --------------------------------------------------------------------------
 * Doctrina (decisión de negocio, 15-jul-2026)
 * --------------------------------------------------------------------------
 *
 * Con el flag ACTIVO un pedido (`ticket_type='ORDER'`, sin cobrar) se trata
 * EXACTAMENTE como una venta normal: suma su total al recaudo y su ganancia
 * real (`total − costo`) a la ganancia del día. Se sigue mostrando como línea
 * DISCRIMINADA "Pedidos (facturación)" para saber qué parte del total viene de
 * pedidos, pero DISCRIMINAR NO ES EXCLUIR: el importe SÍ suma.
 *
 * Consecuencia asumida: con el flag ON, "Total recaudado" incluye dinero que
 * todavía no ha entrado en caja. Es deliberado — el flag existe justo para eso.
 * Con el flag OFF (`ordersTotal = 0`, `ordersProfit = 0`) todo se reduce
 * EXACTAMENTE al comportamiento previo, base caja pura.
 *
 * Lo que este flag NO toca en NINGÚN caso: el cierre de caja físico
 * (`finalTotal` / "faltante del día") ni la ganancia COBRADA canónica
 * (`fetchCollectedProfit`, ver financial-facts/contracts/metrics-spec.md). El
 * delta de pedidos se suma AQUÍ, por encima, nunca dentro del hecho canónico.
 */
export interface TodayTotalsInput {
  /** Dinero recibido de verdad hoy (contado + consignaciones + abonos). */
  collectedCash: number;
  /** Facturación de pedidos del día. 0 con el flag OFF. */
  ordersTotal: number;
  /** Ganancia COBRADA canónica (`fetchCollectedProfit`), base caja. */
  collectedProfit: number;
  /** Ganancia de los pedidos (`total − costo`). 0 con el flag OFF. */
  ordersProfit: number;
  /** Gastos variables del día. */
  expenses: number;
}

export interface TodayTotals {
  totalCollected: number;
  profit: number;
  surplus: number;
  realProfit: number;
}

export function computeTodayTotals(input: TodayTotalsInput): TodayTotals {
  // "Total recaudado" = caja + pedidos asumidos como venta.
  const totalCollected = round2(
    toBig(input.collectedCash).plus(toBig(input.ordersTotal)).toNumber(),
  );
  // "Ganancia del día" = utilidad cobrada + utilidad de los pedidos asumidos.
  const profit = round2(toBig(input.collectedProfit).plus(toBig(input.ordersProfit)).toNumber());
  // Excedente/reinversión = recaudo − utilidad (= COGS). La identidad
  // `recaudo = excedente + ganancia` se mantiene porque ambos lados incluyen
  // los pedidos.
  const surplus = round2(toBig(totalCollected).minus(toBig(profit)).toNumber());
  const realProfit = round2(toBig(profit).minus(toBig(input.expenses)).toNumber());

  return { totalCollected, profit, surplus, realProfit };
}
