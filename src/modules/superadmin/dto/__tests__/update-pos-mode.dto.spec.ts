import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdatePosModeDto } from '../update-pos-mode.dto';

const errorsFor = async (body: unknown) =>
  validate(plainToInstance(UpdatePosModeDto, body as object));

describe('UpdatePosModeDto', () => {
  it.each(['retail', 'restaurant', 'lender'])('acepta %s', async (pos_mode) => {
    expect(await errorsFor({ pos_mode })).toHaveLength(0);
  });

  it.each(['LENDER', 'prestamista', '', null, undefined, 3])('rechaza %p', async (pos_mode) => {
    const errors = await errorsFor({ pos_mode });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('pos_mode');
  });
});
