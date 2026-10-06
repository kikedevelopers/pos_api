import { COMANDAS_CHANGED_EVENT, RealtimeGateway } from '../realtime.gateway';

/**
 * La lista de Comandas (pedidos ORDER activos) debe llegar a TODA la company
 * —cocina/meseros empleados incluidos—, no solo a owner/manager: un pedido
 * nuevo tiene que aparecer en la comanda del cocinero aunque no sea el vendedor.
 * Por eso `comandas:changed` va a la room company-wide, como `tables:changed`.
 */
describe('RealtimeGateway · comandas:changed', () => {
  function build() {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const jwtService = { verify: jest.fn() };
    const configService = { getOrThrow: jest.fn().mockReturnValue('secret') };
    const gateway = new RealtimeGateway(jwtService as never, configService as never);
    (gateway as unknown as { server: unknown }).server = { to };
    return { gateway, to, emit };
  }

  it('emite a la room COMPANY-WIDE (no a la room "all")', () => {
    const { gateway, to, emit } = build();

    gateway.emitComandasChanged(42);

    expect(to).toHaveBeenCalledWith('company:42');
    expect(to).not.toHaveBeenCalledWith('company:42:all');
    expect(emit).toHaveBeenCalledWith(COMANDAS_CHANGED_EVENT, { companyId: 42 });
  });
});
