import {
  hashMessage,
  isExplicitConfirmation,
  type AiToolRequestContext,
  type ConfirmationKind,
} from './expense-tool-helpers';

/**
 * Reglas COMPARTIDAS para ejecutar una operación que Place dejó pendiente
 * (gastos, pedidos, movimientos de tesorería y compras). Puras: deciden con la fila pendiente y el contexto de la
 * petición, sin BD, para que gastos y ventas no puedan divergir en lo único que
 * no admite matices — que nada se ejecute sin el "sí" del usuario.
 */

/** Tipos de operación que viven en `ai_pending_actions`. */
export type PendingActionType =
  | 'REGISTER_EXPENSE'
  | 'VOID_EXPENSE'
  | 'CREATE_SALE'
  | 'TRANSFER_FUNDS'
  | 'ADJUST_BALANCE'
  | 'CREATE_PURCHASE';

export const EXPENSE_ACTION_TYPES: ReadonlySet<PendingActionType> = new Set([
  'REGISTER_EXPENSE',
  'VOID_EXPENSE',
]);

export const TREASURY_ACTION_TYPES: ReadonlySet<PendingActionType> = new Set([
  'TRANSFER_FUNDS',
  'ADJUST_BALANCE',
]);

/** Vocabulario del "sí" que aplica a cada tipo de operación. */
const CONFIRMATION_KIND: Record<PendingActionType, ConfirmationKind> = {
  REGISTER_EXPENSE: 'expense',
  VOID_EXPENSE: 'expense',
  CREATE_SALE: 'sale',
  TRANSFER_FUNDS: 'transfer',
  ADJUST_BALANCE: 'adjust',
  CREATE_PURCHASE: 'purchase',
};

/** Qué es la pendiente y con qué herramienta se confirma. */
const PENDING_OWNER: Record<ConfirmationKind, { label: string; tool: string }> = {
  expense: { label: 'un gasto', tool: 'confirm_expense_action' },
  sale: { label: 'un pedido', tool: 'confirm_sale' },
  transfer: { label: 'un movimiento de saldo', tool: 'confirm_treasury_action' },
  adjust: { label: 'una corrección de saldo', tool: 'confirm_treasury_action' },
  purchase: { label: 'una compra a proveedor', tool: 'confirm_purchase' },
};

/**
 * Respuesta cuando se intenta confirmar con la herramienta de OTRO tipo de
 * operación: no se toca la pendiente y se le dice al modelo cuál usar.
 */
export const wrongOperationResult = (
  action_type: PendingActionType,
): { status: 'wrong_operation'; message: string } => {
  const owner = PENDING_OWNER[CONFIRMATION_KIND[action_type]];
  return {
    status: 'wrong_operation',
    message: `La operación pendiente es ${owner.label}: NO se ejecutó nada con esta herramienta. Confírmala con ${owner.tool}.`,
  };
};

/** Lo que el guard necesita de la fila pendiente (ya bloqueada `FOR UPDATE`). */
export interface PendingConfirmationRow {
  action_type: PendingActionType;
  request_id: string;
  trigger_message_hash: string;
  is_expired: boolean;
}

/**
 * Motivo por el que la confirmación NO procede. `expire` = la pendiente queda
 * inservible (hay que re-prepararla y mostrar un resumen nuevo).
 */
export interface PendingRejection {
  status: string;
  message: string;
  expire: boolean;
}

/**
 * ¿Puede ejecutarse la pendiente con el mensaje actual del usuario? Exige, en
 * este orden:
 *   1. que se haya preparado en una petición ANTERIOR (el usuario ya vio el
 *      resumen — el modelo no puede preparar y confirmar en la misma respuesta);
 *   2. que no haya vencido;
 *   3. que el mensaje previo del usuario sea el que la originó (el "sí"
 *      responde a ESE resumen, no a otro);
 *   4. que el mensaje actual sea un "sí" explícito y nada más.
 *
 * `null` = todo en orden, se puede ejecutar.
 */
export const checkPendingConfirmation = (
  pending: PendingConfirmationRow,
  context: AiToolRequestContext,
): PendingRejection | null => {
  if (pending.request_id === context.request_id) {
    return {
      status: 'awaiting_user_reply',
      message:
        'NO se ejecutó nada: el usuario todavía no ha respondido al resumen. Muéstraselo y espera a que responda "sí".',
      expire: false,
    };
  }
  if (pending.is_expired) {
    return {
      status: 'expired',
      message:
        'La operación preparada venció sin confirmarse. NO se ejecutó nada. Vuelve a prepararla y pide confirmación de nuevo.',
      expire: true,
    };
  }
  if (
    context.previous_user_message === null ||
    hashMessage(context.previous_user_message) !== pending.trigger_message_hash
  ) {
    return {
      status: 'stale_confirmation',
      message:
        'La respuesta del usuario no corresponde al último resumen que se le mostró. NO se ejecutó nada. Vuelve a preparar la operación, muéstrale el resumen y pide su "sí".',
      expire: true,
    };
  }
  if (
    !isExplicitConfirmation(context.current_user_message, CONFIRMATION_KIND[pending.action_type])
  ) {
    return {
      status: 'confirmation_not_explicit',
      message:
        'El usuario no respondió con un "sí" explícito (cambió algo, dijo que no o preguntó otra cosa). NO se ejecutó nada. Si cambió datos, prepara de nuevo con los datos nuevos; si no, pregúntale si confirma.',
      expire: true,
    };
  }
  return null;
};
