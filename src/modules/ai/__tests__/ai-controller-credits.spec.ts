import { HttpException } from '@nestjs/common';

import { AiController } from '../ai.controller';
import type { AiService } from '../ai.service';

/**
 * El controlador del chat reserva el crédito ANTES de abrir el stream, avisa al
 * cliente cuántos quedan y lo devuelve si la respuesta falla sin decir nada.
 */
describe('AiController · créditos del chat', () => {
  const RESERVATION = {
    company_id: 7,
    day: '2026-10-17',
    status: { daily_limit: 5, used_today: 5, remaining: 0 },
  };

  const fakeResponse = () => {
    const written: string[] = [];
    const response = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      status: jest.fn().mockReturnThis(),
      write: jest.fn((chunk: string) => written.push(chunk)),
      end: jest.fn(),
      on: jest.fn(),
    };
    return { response, written };
  };

  const fakeRequest = () => ({ on: jest.fn() });

  const build = (chat: AiService['chat'], reserve?: AiService['reserveChatCredit']) => {
    const service = {
      reserveChatCredit: reserve ?? jest.fn().mockResolvedValue(RESERVATION),
      refundChatCredit: jest.fn().mockResolvedValue(undefined),
      chat: jest.fn(chat),
    };
    return { controller: new AiController(service as unknown as AiService), service };
  };

  const run = async (controller: AiController) => {
    const { response, written } = fakeResponse();
    await controller.chat(
      { turns: [{ role: 'user', content: 'hola' }] } as never,
      { user_id: 1 } as never,
      7,
      fakeRequest() as never,
      response as never,
    );
    return written.join('');
  };

  it('primero envía los créditos que quedan y luego la respuesta', async () => {
    const { controller, service } = build(({ emit }) => {
      emit({ type: 'delta', text: 'Hola' });
      emit({ type: 'done' });
      return Promise.resolve();
    });
    const out = await run(controller);
    expect(out.indexOf('event: credits')).toBeLessThan(out.indexOf('event: delta'));
    expect(out).toContain('"remaining":0');
    expect(service.refundChatCredit).not.toHaveBeenCalled();
  });

  it('si la respuesta falla sin decir nada, devuelve el crédito', async () => {
    const { controller, service } = build(({ emit }) => {
      emit({ type: 'error', message: 'Gemini no responde' });
      return Promise.resolve();
    });
    await run(controller);
    expect(service.refundChatCredit).toHaveBeenCalledWith(RESERVATION);
  });

  it('si el servicio lanza, también se devuelve', async () => {
    const { controller, service } = build(() => Promise.reject(new Error('boom')));
    const out = await run(controller);
    expect(out).toContain('event: error');
    expect(service.refundChatCredit).toHaveBeenCalledTimes(1);
  });

  it('si ya respondió algo y luego falla, NO se devuelve (sí consumió)', async () => {
    const { controller, service } = build(({ emit }) => {
      emit({ type: 'delta', text: 'Parte de la respuesta' });
      emit({ type: 'error', message: 'Se cortó' });
      return Promise.resolve();
    });
    await run(controller);
    expect(service.refundChatCredit).not.toHaveBeenCalled();
  });

  it('sin créditos: el 429 sale como error HTTP y no se abre el stream', async () => {
    const exhausted = new HttpException({ message: 'sin créditos' }, 429);
    const { controller, service } = build(jest.fn(), jest.fn().mockRejectedValue(exhausted));
    const { response } = fakeResponse();
    await expect(
      controller.chat(
        { turns: [] },
        { user_id: 1 } as never,
        7,
        fakeRequest() as never,
        response as never,
      ),
    ).rejects.toBe(exhausted);
    expect(service.chat).not.toHaveBeenCalled();
    expect(response.write).not.toHaveBeenCalled();
  });
});
