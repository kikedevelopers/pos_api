import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdatePosModeDto } from '../../dto/update-pos-mode.dto';
import { UpdatePosModeAction } from '../update-pos-mode.action';

// ---------------------------------------------------------------------------
// Selector del modo del POS por negocio (retail | restaurant).
//
// Se administra por company, sucursales incluidas: una sucursal puede ser un
// restaurante aunque su principal sea una tienda. La action solo persiste el
// selector; el cliente decide qué ventana abrir.
// ---------------------------------------------------------------------------

interface Options {
  company: Record<string, unknown> | null;
}

function build(opts: Options) {
  const save = jest.fn((c: Record<string, unknown>) => Promise.resolve(c));
  const findOne = jest.fn().mockResolvedValue(opts.company);
  const manager = {
    getRepository: () => ({ findOne, save }),
  };
  const dataSource = {
    transaction: jest.fn((_level: string, cb: (m: unknown) => Promise<unknown>) => cb(manager)),
  };
  return {
    action: new UpdatePosModeAction(dataSource as never),
    save,
    findOne,
    dataSource,
  };
}

const PRINCIPAL = { id: '8', name: 'Esencia & Grano', is_branch: false, pos_mode: 'retail' };
const SUCURSAL = { id: '12', name: 'Esencia & Grano Sur', is_branch: true, pos_mode: 'retail' };

describe('UpdatePosModeAction', () => {
  it('404 si la company no existe (no persiste nada)', async () => {
    const { action, save } = build({ company: null });

    await expect(action.execute(999, { pos_mode: 'restaurant' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('busca la company por el id recibido', async () => {
    const { action, findOne } = build({ company: { ...PRINCIPAL } });

    await action.execute(8, { pos_mode: 'restaurant' });

    expect(findOne).toHaveBeenCalledWith({ where: { id: '8' } });
  });

  it('pasa el negocio principal a restaurant', async () => {
    const { action, save } = build({ company: { ...PRINCIPAL } });

    const result = await action.execute(8, { pos_mode: 'restaurant' });

    expect(result).toEqual({ pos_mode: 'restaurant' });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: '8', pos_mode: 'restaurant' }));
  });

  it('devuelve el negocio a retail', async () => {
    const { action, save } = build({ company: { ...PRINCIPAL, pos_mode: 'restaurant' } });

    const result = await action.execute(8, { pos_mode: 'retail' });

    expect(result).toEqual({ pos_mode: 'retail' });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: '8', pos_mode: 'retail' }));
  });

  it('una SUCURSAL también puede tener su propio modo', async () => {
    const { action, save } = build({ company: { ...SUCURSAL } });

    const result = await action.execute(12, { pos_mode: 'restaurant' });

    expect(result).toEqual({ pos_mode: 'restaurant' });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ id: '12', is_branch: true, pos_mode: 'restaurant' }),
    );
  });

  it('solo toca pos_mode: el resto de la company queda intacto', async () => {
    const original = { ...PRINCIPAL, electronic_billing_enabled: true, document_number: 'J-1' };
    const { action, save } = build({ company: { ...original } });

    await action.execute(8, { pos_mode: 'restaurant' });

    expect(save).toHaveBeenCalledWith({ ...original, pos_mode: 'restaurant' });
  });

  it('persiste dentro de una transacción SERIALIZABLE', async () => {
    const { action, dataSource } = build({ company: { ...PRINCIPAL } });

    await action.execute(8, { pos_mode: 'restaurant' });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(dataSource.transaction.mock.calls[0][0]).toBe('SERIALIZABLE');
  });
});

describe('UpdatePosModeDto', () => {
  const errorsFor = (body: unknown) => validate(plainToInstance(UpdatePosModeDto, body));

  it.each(['retail', 'restaurant'])('acepta pos_mode=%s', async (pos_mode) => {
    expect(await errorsFor({ pos_mode })).toHaveLength(0);
  });

  it.each([
    ['ausente', {}],
    ['null', { pos_mode: null }],
    ['vacío', { pos_mode: '' }],
    ['mayúsculas', { pos_mode: 'RESTAURANT' }],
    ['modo desconocido', { pos_mode: 'bar' }],
    ['booleano', { pos_mode: true }],
    ['número', { pos_mode: 1 }],
  ])('rechaza pos_mode %s', async (_label, body) => {
    const errors = await errorsFor(body);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('pos_mode');
  });

  it('con las opciones del pipe global rechaza campos que no son del contrato', async () => {
    const errors = await validate(
      plainToInstance(UpdatePosModeDto, { pos_mode: 'retail', company_id: 99 }),
      { whitelist: true, forbidNonWhitelisted: true },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('company_id');
  });
});
