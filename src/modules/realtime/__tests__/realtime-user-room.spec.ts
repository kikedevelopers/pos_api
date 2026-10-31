import { RealtimeGateway } from '../realtime.gateway';

/**
 * Avisos que cruzan sucursales: un pedido del agente en la sucursal X tiene que
 * llegarle al dueño aunque su sesión esté en el principal o en la sucursal Y.
 * Para eso cada socket entra también a `user:<id>` (independiente del negocio).
 */
describe('RealtimeGateway · room de usuario (cruza sucursales)', () => {
  function build(payload: Record<string, unknown>) {
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    const jwtService = { verify: jest.fn().mockReturnValue(payload) };
    const configService = { getOrThrow: jest.fn().mockReturnValue('secret') };
    const gateway = new RealtimeGateway(jwtService as never, configService as never);
    (gateway as unknown as { server: unknown }).server = { to };
    const client = {
      handshake: { auth: { token: 'jwt' }, headers: {} },
      join: jest.fn(),
      disconnect: jest.fn(),
    };
    return { gateway, to, emit, client };
  }

  it('al conectar, el socket entra a su room de usuario', () => {
    const { gateway, client } = build({ user_id: 7, company_id: 13, type: 'owner' });
    gateway.handleConnection(client as never);
    expect(client.join).toHaveBeenCalledWith('user:7');
    expect(client.join).toHaveBeenCalledWith('company:13:user:7');
  });

  it('emitToUsers: a las rooms de esos usuarios, sin duplicados ni ids inválidos', () => {
    const { gateway, to, emit } = build({});
    gateway.emitToUsers([7, 7, 9, 0], 'alert:created', { companyId: 20 });
    expect(to).toHaveBeenCalledWith(['user:7', 'user:9']);
    expect(emit).toHaveBeenCalledWith('alert:created', { companyId: 20 });
  });

  it('emitToUsers sin usuarios: no emite', () => {
    const { gateway, to } = build({});
    gateway.emitToUsers([], 'alert:created', {});
    expect(to).not.toHaveBeenCalled();
  });
});
