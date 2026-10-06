import { ValidationPipe, BadRequestException } from '@nestjs/common';

import { UpdateSaleDto } from '../dto/update-sale.dto';

/**
 * Regresión de un bug de PRODUCCIÓN en el POS retail: al EDITAR/actualizar un
 * pedido, el cliente enviaba `table_id`/`salon_id` (campos del modo
 * restaurante) en el payload de actualización, y el `UpdateSaleDto` —con
 * `forbidNonWhitelisted`— los rechazaba con
 * "property table_id should not exist; property salon_id should not exist".
 *
 * El POS retail NUNCA debe verse afectado por el modo restaurante. Defensa en
 * el backend: el `UpdateSaleDto` ACEPTA esas propiedades (y las IGNORA: editar
 * no reasigna la mesa) para que una app ya desplegada que aún las envíe no
 * reciba un 400.
 */
describe('UpdateSaleDto — tolera table_id/salon_id (modo restaurante) en la edición', () => {
  // Mismo pipe que en main.ts.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const meta = { type: 'body' as const, metatype: UpdateSaleDto };

  const baseEdit = {
    total: 1000,
    cost: 600,
    profit: 400,
    margin: 40,
    customer_id: 5,
    customer_name: 'Maira Herrera',
  };

  it('NO rechaza un payload de edición con table_id y salon_id (número)', async () => {
    const payload = { ...baseEdit, table_id: 77, salon_id: 3 };
    const result = (await pipe.transform(payload, meta)) as UpdateSaleDto;
    // Se aceptan (quedan en el DTO), pero la action los ignora: la mesa no se
    // reasigna al editar.
    expect(result.table_id).toBe(77);
    expect(result.salon_id).toBe(3);
  });

  it('NO rechaza table_id/salon_id = null (lo que manda el registro directo/retail)', async () => {
    const payload = { ...baseEdit, table_id: null, salon_id: null };
    await expect(pipe.transform(payload, meta)).resolves.toMatchObject({
      table_id: null,
      salon_id: null,
    });
  });

  it('una edición de retail SIN esos campos sigue validando igual (sin regresión)', async () => {
    await expect(pipe.transform({ ...baseEdit }, meta)).resolves.toMatchObject(baseEdit);
  });

  it('rechaza un table_id inválido (0): el campo sí se valida cuando viene', async () => {
    await expect(pipe.transform({ ...baseEdit, table_id: 0 }, meta)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
