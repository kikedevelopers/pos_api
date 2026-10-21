import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { DataSource, EntityManager } from 'typeorm';

import { GetTicketPrintAction } from '../actions/get-ticket-print.action';
import { UpsertTicketPrintAction } from '../actions/upsert-ticket-print.action';
import { UpdateTicketPrintDto } from '../dto/ticket-print.dto';
import { APP_SETTING_KEYS } from '../entities/app-setting.entity';
import {
  getTicketPrintConfig,
  normalizeTicketTypes,
  setTicketPrintConfig,
} from '../internal/ticket-print-config';

/**
 * Configuración de impresión del ticket (espacios a mano: observaciones/firma),
 * cada uno con sus tipos de ticket (SALE / ORDER / CREDIT).
 *
 * Cubre: defaults (apagados, en todos los tipos) sin filas, lectura
 * independiente, tolerancia a valores corruptos, upsert PARCIAL normalizado,
 * validación del DTO y la action (400 sin campos, devuelve la config completa).
 */
type RowsByKey = Record<string, { value: string } | null>;

interface ManagerMock {
  manager: EntityManager;
  findOne: jest.Mock;
  upsert: jest.Mock;
}

const ALL_TYPES = ['SALE', 'ORDER', 'CREDIT'];

const buildManager = (rows: RowsByKey = {}): ManagerMock => {
  const findOne = jest.fn(({ where }: { where: { key: string } }) =>
    Promise.resolve(rows[where.key] ?? null),
  );
  const upsert = jest.fn().mockResolvedValue(undefined);
  const manager = {
    getRepository: jest.fn().mockReturnValue({ findOne, upsert }),
  } as unknown as EntityManager;
  return { manager, findOne, upsert };
};

describe('normalizeTicketTypes', () => {
  it('deja solo tipos conocidos, sin duplicados y en orden canónico', () => {
    expect(normalizeTicketTypes(['CREDIT', 'SALE', 'CREDIT', 'LOAN', 3])).toEqual([
      'SALE',
      'CREDIT',
    ]);
  });

  it('vacío o sin ningún tipo válido ⇒ todos', () => {
    expect(normalizeTicketTypes([])).toEqual(ALL_TYPES);
    expect(normalizeTicketTypes(['LOAN', null])).toEqual(ALL_TYPES);
  });
});

describe('getTicketPrintConfig', () => {
  it('default: apagados y en TODOS los tipos cuando las keys NO existen', async () => {
    const { manager } = buildManager();
    await expect(getTicketPrintConfig(manager, 42)).resolves.toEqual({
      observations_enabled: false,
      observations_ticket_types: ALL_TYPES,
      signature_enabled: false,
      signature_ticket_types: ALL_TYPES,
    });
  });

  it('lee cada espacio de forma independiente', async () => {
    const { manager } = buildManager({
      [APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_ENABLED]: { value: 'true' },
      [APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_TICKET_TYPES]: { value: '["ORDER"]' },
      [APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_ENABLED]: { value: 'false' },
      [APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_TICKET_TYPES]: { value: '["CREDIT","ORDER"]' },
    });
    await expect(getTicketPrintConfig(manager, 42)).resolves.toEqual({
      observations_enabled: true,
      observations_ticket_types: ['ORDER'],
      signature_enabled: false,
      signature_ticket_types: ['ORDER', 'CREDIT'],
    });
  });

  it("un enabled distinto de 'true' se trata como false", async () => {
    const { manager } = buildManager({
      [APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_ENABLED]: { value: 'TRUE' },
      [APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_ENABLED]: { value: '1' },
    });
    const config = await getTicketPrintConfig(manager, 42);
    expect(config.observations_enabled).toBe(false);
    expect(config.signature_enabled).toBe(false);
  });

  it.each([
    ['JSON inválido', '{no-json'],
    ['no es array', '"ORDER"'],
    ['array vacío', '[]'],
    ['solo tipos desconocidos', '["LOAN"]'],
  ])('tipos corruptos (%s) caen a TODOS', async (_label, value) => {
    const { manager } = buildManager({
      [APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_TICKET_TYPES]: { value },
    });
    const config = await getTicketPrintConfig(manager, 42);
    expect(config.signature_ticket_types).toEqual(ALL_TYPES);
  });

  it('filtra por company_id', async () => {
    const { manager, findOne } = buildManager();
    await getTicketPrintConfig(manager, 7);
    expect(findOne).toHaveBeenCalledTimes(4);
    for (const [{ where }] of findOne.mock.calls as [{ where: { company_id: string } }][]) {
      expect(where.company_id).toBe('7');
    }
  });
});

describe('setTicketPrintConfig', () => {
  it('upsert de todas las keys cuando vienen todos los campos', async () => {
    const { manager, upsert } = buildManager();
    await setTicketPrintConfig(manager, 42, {
      observations_enabled: true,
      observations_ticket_types: ['ORDER', 'SALE'],
      signature_enabled: false,
      signature_ticket_types: ['CREDIT'],
    });
    expect(upsert).toHaveBeenCalledWith(
      [
        {
          company_id: '42',
          key: APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_ENABLED,
          value: 'true',
        },
        { company_id: '42', key: APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_ENABLED, value: 'false' },
        {
          company_id: '42',
          key: APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_TICKET_TYPES,
          value: '["SALE","ORDER"]',
        },
        {
          company_id: '42',
          key: APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_TICKET_TYPES,
          value: '["CREDIT"]',
        },
      ],
      ['company_id', 'key'],
    );
  });

  it('PARCIAL: solo persiste el campo enviado (no pisa los demás)', async () => {
    const { manager, upsert } = buildManager();
    await setTicketPrintConfig(manager, 42, { signature_ticket_types: ['CREDIT', 'ORDER'] });
    expect(upsert).toHaveBeenCalledWith(
      [
        {
          company_id: '42',
          key: APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_TICKET_TYPES,
          value: '["ORDER","CREDIT"]',
        },
      ],
      ['company_id', 'key'],
    );
  });

  it('no-op si el patch no trae campos', async () => {
    const { manager, upsert } = buildManager();
    await setTicketPrintConfig(manager, 42, {});
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('UpdateTicketPrintDto · validación', () => {
  const errorsOf = async (plain: object): Promise<string[]> =>
    (await validate(plainToInstance(UpdateTicketPrintDto, plain))).map((e) => e.property);

  it('acepta un payload parcial válido', async () => {
    await expect(errorsOf({ observations_ticket_types: ['ORDER', 'CREDIT'] })).resolves.toEqual([]);
    await expect(errorsOf({ signature_enabled: true })).resolves.toEqual([]);
    await expect(errorsOf({})).resolves.toEqual([]);
  });

  it('rechaza una lista vacía de tipos', async () => {
    await expect(errorsOf({ signature_ticket_types: [] })).resolves.toEqual([
      'signature_ticket_types',
    ]);
  });

  it('rechaza tipos desconocidos', async () => {
    await expect(errorsOf({ observations_ticket_types: ['SALE', 'LOAN'] })).resolves.toEqual([
      'observations_ticket_types',
    ]);
  });

  it('rechaza tipos duplicados', async () => {
    await expect(errorsOf({ observations_ticket_types: ['SALE', 'SALE'] })).resolves.toEqual([
      'observations_ticket_types',
    ]);
  });

  it('rechaza tipos que no son array y enabled que no es booleano', async () => {
    await expect(
      errorsOf({ signature_ticket_types: 'CREDIT', observations_enabled: 'true' }),
    ).resolves.toEqual(expect.arrayContaining(['signature_ticket_types', 'observations_enabled']));
  });
});

describe('GetTicketPrintAction', () => {
  it('delega en el manager del DataSource', async () => {
    const { manager } = buildManager({
      [APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_ENABLED]: { value: 'true' },
    });
    const action = new GetTicketPrintAction({ manager } as unknown as DataSource);
    await expect(action.execute(42)).resolves.toEqual({
      observations_enabled: false,
      observations_ticket_types: ALL_TYPES,
      signature_enabled: true,
      signature_ticket_types: ALL_TYPES,
    });
  });
});

describe('UpsertTicketPrintAction', () => {
  const buildAction = (
    rows: RowsByKey = {},
  ): ManagerMock & { transaction: jest.Mock; action: UpsertTicketPrintAction } => {
    const built = buildManager(rows);
    const transaction = jest.fn((cb: (m: EntityManager) => Promise<unknown>) => cb(built.manager));
    const action = new UpsertTicketPrintAction({ transaction } as unknown as DataSource);
    return { ...built, transaction, action };
  };

  it('rechaza (400) un payload sin campos y no abre transacción', async () => {
    const { action, transaction } = buildAction();
    await expect(action.execute({}, 42)).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('persiste solo el campo enviado y devuelve la config COMPLETA', async () => {
    // La firma ya estaba activa en BD: se conserva y se devuelve.
    const { action, upsert } = buildAction({
      [APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_ENABLED]: { value: 'true' },
      [APP_SETTING_KEYS.TICKET_SIGNATURE_SPACE_TICKET_TYPES]: { value: '["CREDIT"]' },
    });
    await expect(action.execute({ observations_enabled: false }, 42)).resolves.toEqual({
      observations_enabled: false,
      observations_ticket_types: ALL_TYPES,
      signature_enabled: true,
      signature_ticket_types: ['CREDIT'],
    });
    expect(upsert).toHaveBeenCalledWith(
      [
        {
          company_id: '42',
          key: APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_ENABLED,
          value: 'false',
        },
      ],
      ['company_id', 'key'],
    );
  });

  it('guarda los tipos de ticket de un espacio', async () => {
    const { action, upsert } = buildAction();
    await action.execute({ observations_ticket_types: ['ORDER'] }, 42);
    expect(upsert).toHaveBeenCalledWith(
      [
        {
          company_id: '42',
          key: APP_SETTING_KEYS.TICKET_OBSERVATIONS_SPACE_TICKET_TYPES,
          value: '["ORDER"]',
        },
      ],
      ['company_id', 'key'],
    );
  });

  it('acepta todos los campos a la vez', async () => {
    const { action, upsert } = buildAction();
    await action.execute(
      {
        observations_enabled: true,
        observations_ticket_types: ['SALE'],
        signature_enabled: true,
        signature_ticket_types: ['CREDIT'],
      },
      42,
    );
    const [[rows]] = upsert.mock.calls as [[unknown[]]];
    expect(rows).toHaveLength(4);
  });
});
