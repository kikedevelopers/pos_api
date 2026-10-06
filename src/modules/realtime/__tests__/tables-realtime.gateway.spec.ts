import { TABLES_CHANGED_EVENT, RealtimeGateway } from '../realtime.gateway';

/**
 * El estado de mesas debe llegar a TODA la company (meseros/cajeros incluidos),
 * no solo a owner/manager: si solo llegara a la room 'all', un empleado seguiría
 * viendo una mesa libre que otro acaba de ocupar.
 */
describe('RealtimeGateway · tables:changed', () => {
  function build() {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const jwtService = { verify: jest.fn() };
    const configService = { getOrThrow: jest.fn().mockReturnValue('secret') };
    const gateway = new RealtimeGateway(jwtService as never, configService as never);
    (gateway as unknown as { server: unknown }).server = { to };
    return { gateway, to, emit, jwtService };
  }

  it('emite a la room COMPANY-WIDE (no a la room "all")', () => {
    const { gateway, to, emit } = build();

    gateway.emitTablesChanged(42);

    expect(to).toHaveBeenCalledWith('company:42');
    expect(to).not.toHaveBeenCalledWith('company:42:all');
    expect(emit).toHaveBeenCalledWith(TABLES_CHANGED_EVENT, { companyId: 42 });
  });

  it('un EMPLEADO se une a la room company-wide (recibe tables:changed)', () => {
    const { gateway, jwtService } = build();
    jwtService.verify.mockReturnValue({ user_id: 7, company_id: 42, type: 'employee' });
    const join = jest.fn();
    const client = {
      handshake: { auth: { token: 'tok' }, headers: {} },
      join,
      disconnect: jest.fn(),
    };

    gateway.handleConnection(client as never);

    expect(join).toHaveBeenCalledWith('company:42');
    // El empleado NO entra a la room agregada 'all' (sigue siendo solo de admins).
    expect(join).not.toHaveBeenCalledWith('company:42:all');
  });

  it('owner se une a company-wide Y a la room agregada', () => {
    const { gateway, jwtService } = build();
    jwtService.verify.mockReturnValue({ user_id: 1, company_id: 42, type: 'owner' });
    const join = jest.fn();
    const client = {
      handshake: { auth: { token: 'tok' }, headers: {} },
      join,
      disconnect: jest.fn(),
    };

    gateway.handleConnection(client as never);

    expect(join).toHaveBeenCalledWith('company:42');
    expect(join).toHaveBeenCalledWith('company:42:all');
  });
});
