import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { ArchivePurchaseDto } from '../dto/archive-purchase.dto';

/**
 * Regresión: PlacePos envía `client_operation_id` al archivar una compra y el
 * pipe global (whitelist + forbidNonWhitelisted) lo rechazaba con
 * "property client_operation_id should not exist", bloqueando el archivado.
 */
describe('ArchivePurchaseDto — payload de PlacePos', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const meta = { type: 'body' as const, metatype: ArchivePurchaseDto };
  const operation_id = '550e8400-e29b-41d4-a716-446655440000';

  const transform = (payload: Record<string, unknown>): Promise<ArchivePurchaseDto> =>
    pipe.transform(payload, meta) as Promise<ArchivePurchaseDto>;

  const getMessages = async (payload: Record<string, unknown>): Promise<string[]> => {
    try {
      await transform(payload);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as { message: string[] };
      return response.message;
    }
    throw new Error('Se esperaba que la validación fallara');
  };

  it('acepta el payload completo que envía PlacePos (con client_operation_id)', async () => {
    const result = await transform({
      refund_source_type: 'cash_register',
      refund_source_id: 3,
      force_stock_adjustment: false,
      client_operation_id: operation_id,
    });

    expect(result.client_operation_id).toBe(operation_id);
    expect(result.refund_source_type).toBe('cash_register');
    expect(result.refund_source_id).toBe(3);
    expect(result.force_stock_adjustment).toBe(false);
  });

  it('acepta compra sin pagos: fuentes de reembolso en null', async () => {
    const result = await transform({
      refund_source_type: null,
      refund_source_id: null,
      force_stock_adjustment: false,
      client_operation_id: operation_id,
    });

    expect(result.refund_source_type).toBeNull();
    expect(result.refund_source_id).toBeNull();
  });

  it('acepta client_operation_id en null o ausente', async () => {
    await expect(transform({ client_operation_id: null })).resolves.toBeDefined();
    await expect(transform({})).resolves.toBeDefined();
  });

  it('rechaza client_operation_id que no es UUID v4', async () => {
    const messages = await getMessages({ client_operation_id: 'no-es-uuid' });
    expect(messages).toContain('client_operation_id debe ser un UUID v4 válido');
  });

  it('rechaza una fuente de reembolso inválida', async () => {
    const messages = await getMessages({ refund_source_type: 'paypal', refund_source_id: 1 });
    expect(messages).toContain('Fuente del reembolso inválida. Usa wallet, bank o cash_register.');
  });

  it('rechaza refund_source_id menor a 1', async () => {
    const messages = await getMessages({ refund_source_type: 'bank', refund_source_id: 0 });
    expect(messages).toContain('refund_source_id debe ser >= 1');
  });

  it('sigue rechazando propiedades desconocidas', async () => {
    const messages = await getMessages({ client_operation_id: operation_id, foo: 'bar' });
    expect(messages).toContain('property foo should not exist');
  });
});
