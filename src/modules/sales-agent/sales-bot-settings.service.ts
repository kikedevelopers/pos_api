import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  SALES_BOT_PERSONALITIES,
  isSalesBotPersonality,
  type SalesBotPersonality,
} from './entities/sales-bot-config.entity';
import {
  DEFAULT_SALES_BOT_DELIVERY_MODES,
  DEFAULT_SALES_BOT_OFF_TOPIC_LIMIT,
  MAX_SALES_BOT_OFF_TOPIC_LIMIT,
  DEFAULT_SALES_BOT_PAYMENT_METHODS,
  MAX_SALES_BOT_PAYMENT_INSTRUCTIONS_LEN,
  MAX_SALES_BOT_PICKUP_ADDRESS_LEN,
  SALES_BOT_DELIVERY_MODE_VALUES,
  MAX_SALES_BOT_STYLE_LEN,
  SALES_BOT_PAYMENT_METHOD_VALUES,
  SALES_BOT_STOCK_POLICIES,
  SalesBotSettingsEntity,
  isSalesBotDeliveryMode,
  isSalesBotPaymentMethod,
  isSalesBotStockPolicy,
  type SalesBotDeliveryMode,
  type SalesBotPaymentMethod,
  type SalesBotStockPolicy,
} from './entities/sales-bot-settings.entity';

/** Ajustes del agente que ve y edita el dueño (iguales en todos los canales). */
export interface SalesBotSettings {
  /** Nombre con el que se presenta. Vacío = el nombre por defecto del agente. */
  bot_name: string;
  personality: SalesBotPersonality;
  stock_policy: SalesBotStockPolicy;
  /** Estilo propio del dueño por etapa de la venta. Vacío = el del preset. */
  greeting_style: string;
  selling_style: string;
  closing_style: string;
  /** Formas de pago que acepta el negocio (al menos una, en orden canónico). */
  payment_methods: SalesBotPaymentMethod[];
  /** Indicaciones de pago que el agente comparte. Vacío = ninguna. */
  payment_instructions: string;
  /** Entregas que ofrece el negocio (al menos una, en orden canónico). */
  delivery_modes: SalesBotDeliveryMode[];
  /** Dónde se recoge. Vacío = la dirección del negocio. */
  pickup_address: string;
  /** Mensajes fuera de tema antes de despedirse y callar (0 = filtro apagado). */
  off_topic_limit: number;
}

/**
 * Cambios a guardar. Los campos omitidos conservan su valor (clientes viejos
 * solo envían `stock_policy` o la persona).
 */
export type UpdateSalesBotSettingsInput = Partial<SalesBotSettings>;

export const DEFAULT_SALES_BOT_SETTINGS: SalesBotSettings = {
  bot_name: '',
  personality: SALES_BOT_PERSONALITIES.AMABLE_PROFESIONAL,
  stock_policy: SALES_BOT_STOCK_POLICIES.INFORM,
  greeting_style: '',
  selling_style: '',
  closing_style: '',
  payment_methods: [...DEFAULT_SALES_BOT_PAYMENT_METHODS],
  payment_instructions: '',
  delivery_modes: [...DEFAULT_SALES_BOT_DELIVERY_MODES],
  pickup_address: '',
  off_topic_limit: DEFAULT_SALES_BOT_OFF_TOPIC_LIMIT,
};

export const MAX_SALES_BOT_NAME_LEN = 60;

const STYLE_FIELDS = ['greeting_style', 'selling_style', 'closing_style'] as const;

/** Recorta y colapsa espacios/saltos: el texto va a una sola línea del prompt. */
export const normalizeFreeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Formas de pago válidas, sin duplicados y en el orden canónico. */
export const normalizePaymentMethods = (values: readonly unknown[]): SalesBotPaymentMethod[] =>
  SALES_BOT_PAYMENT_METHOD_VALUES.filter((method) => values.includes(method));

/** Entregas válidas, sin duplicados y en el orden canónico. */
export const normalizeDeliveryModes = (values: readonly unknown[]): SalesBotDeliveryMode[] =>
  SALES_BOT_DELIVERY_MODE_VALUES.filter((mode) => values.includes(mode));

/**
 * Ajustes del agente por negocio (aplican a todos los canales). Si el negocio
 * no tiene fila, rigen los defaults.
 */
@Injectable()
export class SalesBotSettingsService {
  constructor(
    @InjectRepository(SalesBotSettingsEntity)
    private readonly repo: Repository<SalesBotSettingsEntity>,
  ) {}

  async get(companyId: number): Promise<SalesBotSettings> {
    const entity = await this.repo.findOne({ where: { company_id: String(companyId) } });
    return toSettings(entity);
  }

  async update(companyId: number, input: UpdateSalesBotSettingsInput): Promise<SalesBotSettings> {
    const botName = input.bot_name === undefined ? undefined : input.bot_name.trim();
    if (botName !== undefined && botName.length > MAX_SALES_BOT_NAME_LEN) {
      throw new BadRequestException(
        `El nombre del agente no puede superar ${MAX_SALES_BOT_NAME_LEN} caracteres.`,
      );
    }
    if (input.personality !== undefined && !isSalesBotPersonality(input.personality)) {
      throw new BadRequestException('Personalidad del agente no válida.');
    }
    if (input.stock_policy !== undefined && !isSalesBotStockPolicy(input.stock_policy)) {
      throw new BadRequestException('Política de stock no válida.');
    }

    const styles: Partial<Record<(typeof STYLE_FIELDS)[number], string>> = {};
    for (const field of STYLE_FIELDS) {
      const raw = input[field];
      if (raw === undefined) continue;
      const text = normalizeFreeText(raw);
      if (text.length > MAX_SALES_BOT_STYLE_LEN) {
        throw new BadRequestException(
          `Cada indicación de estilo admite máximo ${MAX_SALES_BOT_STYLE_LEN} caracteres.`,
        );
      }
      styles[field] = text;
    }

    let paymentMethods: SalesBotPaymentMethod[] | undefined;
    if (input.payment_methods !== undefined) {
      if (!input.payment_methods.every(isSalesBotPaymentMethod)) {
        throw new BadRequestException('Forma de pago no válida.');
      }
      paymentMethods = normalizePaymentMethods(input.payment_methods);
      if (paymentMethods.length === 0) {
        throw new BadRequestException('Elige al menos una forma de pago.');
      }
    }

    const paymentInstructions =
      input.payment_instructions === undefined
        ? undefined
        : normalizeFreeText(input.payment_instructions);
    if (
      paymentInstructions !== undefined &&
      paymentInstructions.length > MAX_SALES_BOT_PAYMENT_INSTRUCTIONS_LEN
    ) {
      throw new BadRequestException(
        `Las indicaciones de pago admiten máximo ${MAX_SALES_BOT_PAYMENT_INSTRUCTIONS_LEN} caracteres.`,
      );
    }

    let deliveryModes: SalesBotDeliveryMode[] | undefined;
    if (input.delivery_modes !== undefined) {
      if (!input.delivery_modes.every(isSalesBotDeliveryMode)) {
        throw new BadRequestException('Forma de entrega no válida.');
      }
      deliveryModes = normalizeDeliveryModes(input.delivery_modes);
      if (deliveryModes.length === 0) {
        throw new BadRequestException('Elige al menos una forma de entrega.');
      }
    }

    const pickupAddress =
      input.pickup_address === undefined ? undefined : normalizeFreeText(input.pickup_address);
    if (pickupAddress !== undefined && pickupAddress.length > MAX_SALES_BOT_PICKUP_ADDRESS_LEN) {
      throw new BadRequestException(
        `La dirección de recogida admite máximo ${MAX_SALES_BOT_PICKUP_ADDRESS_LEN} caracteres.`,
      );
    }

    const offTopicLimit = input.off_topic_limit;
    if (
      offTopicLimit !== undefined &&
      (!Number.isInteger(offTopicLimit) ||
        offTopicLimit < 0 ||
        offTopicLimit > MAX_SALES_BOT_OFF_TOPIC_LIMIT)
    ) {
      throw new BadRequestException(
        `El límite de mensajes fuera de tema va de 0 (apagado) a ${MAX_SALES_BOT_OFF_TOPIC_LIMIT}.`,
      );
    }

    const existing = await this.repo.findOne({ where: { company_id: String(companyId) } });
    const entity = existing ?? this.repo.create({ company_id: String(companyId) });
    if (botName !== undefined) {
      entity.bot_name = botName;
    }
    if (input.personality !== undefined) {
      entity.personality = input.personality;
    }
    if (input.stock_policy !== undefined) {
      entity.stock_policy = input.stock_policy;
    }
    for (const field of STYLE_FIELDS) {
      const text = styles[field];
      if (text !== undefined) {
        entity[field] = text;
      }
    }
    if (paymentMethods !== undefined) {
      entity.payment_methods = paymentMethods;
    }
    if (paymentInstructions !== undefined) {
      entity.payment_instructions = paymentInstructions;
    }
    if (deliveryModes !== undefined) {
      entity.delivery_modes = deliveryModes;
    }
    if (pickupAddress !== undefined) {
      entity.pickup_address = pickupAddress;
    }
    if (offTopicLimit !== undefined) {
      entity.off_topic_limit = offTopicLimit;
    }
    const saved = await this.repo.save(entity);
    return toSettings(saved);
  }
}

const toSettings = (entity: SalesBotSettingsEntity | null): SalesBotSettings => {
  const deliveryModes = Array.isArray(entity?.delivery_modes)
    ? normalizeDeliveryModes(entity.delivery_modes)
    : [];
  const paymentMethods = Array.isArray(entity?.payment_methods)
    ? normalizePaymentMethods(entity.payment_methods)
    : [];
  return {
    bot_name: entity?.bot_name?.trim() ?? DEFAULT_SALES_BOT_SETTINGS.bot_name,
    personality: isSalesBotPersonality(entity?.personality)
      ? entity.personality
      : DEFAULT_SALES_BOT_SETTINGS.personality,
    stock_policy: isSalesBotStockPolicy(entity?.stock_policy)
      ? entity.stock_policy
      : DEFAULT_SALES_BOT_SETTINGS.stock_policy,
    greeting_style: entity?.greeting_style?.trim() ?? '',
    selling_style: entity?.selling_style?.trim() ?? '',
    closing_style: entity?.closing_style?.trim() ?? '',
    payment_methods:
      paymentMethods.length > 0 ? paymentMethods : [...DEFAULT_SALES_BOT_PAYMENT_METHODS],
    payment_instructions: entity?.payment_instructions?.trim() ?? '',
    delivery_modes:
      deliveryModes.length > 0 ? deliveryModes : [...DEFAULT_SALES_BOT_DELIVERY_MODES],
    pickup_address: entity?.pickup_address?.trim() ?? '',
    off_topic_limit: readOffTopicLimit(entity?.off_topic_limit),
  };
};

/** Límite guardado o el default si viene vacío o fuera de rango. */
const readOffTopicLimit = (value: unknown): number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= MAX_SALES_BOT_OFF_TOPIC_LIMIT
    ? value
    : DEFAULT_SALES_BOT_OFF_TOPIC_LIMIT;
