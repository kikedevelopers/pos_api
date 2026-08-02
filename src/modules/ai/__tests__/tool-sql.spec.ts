import {
  buildCustomerDebtSubquery,
  buildDebtorTotalsSql,
  buildTopDebtorsSql,
} from '../internal/tool-sql';

/** Aplana el SQL para poder buscar fragmentos sin pelear con la indentación. */
const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/**
 * Estas pruebas blindan un bug real: la cartera del asistente sumaba los
 * créditos de ventas ANULADAS y reportaba $ 279.500 donde el informe de Cartera
 * decía $ 147.300. No era una alucinación del modelo — era un `WHERE`
 * incompleto que el modelo repitió con toda seguridad.
 */
describe('SQL de la cartera del asistente', () => {
  const queries = [
    ['totales', buildDebtorTotalsSql()],
    ['deudores', buildTopDebtorsSql()],
  ] as const;

  it.each(queries)('%s: solo cuenta créditos de facturas vigentes', (_name, sql) => {
    const query = flat(sql);

    expect(query).toContain('INNER JOIN sale_invoices si');
    expect(query).toContain('si.id = sc.sale_invoice_id');
    expect(query).toContain("si.ticket_type = 'SALE'");
    expect(query).toContain('si.is_deleted = false');
  });

  it.each(queries)('%s: pendiente es saldo > 0, no un estado', (_name, sql) => {
    const query = flat(sql);

    expect(query).toContain('sc.balance > 0');
    // `status <> 'PAID'` era el criterio viejo: dependía de que el estado se
    // hubiera actualizado bien y no miraba la factura.
    expect(query).not.toContain("status <> 'PAID'");
  });

  it.each(queries)('%s: filtra por company en el crédito y en la factura', (_name, sql) => {
    const query = flat(sql);

    expect(query).toContain('sc.company_id = $1');
    expect(query).toContain('si.company_id = sc.company_id');
  });

  it('los deudores se agrupan por cliente y se ordenan por saldo', () => {
    const query = flat(buildTopDebtorsSql());

    expect(query).toContain('GROUP BY c.id, c.name, c.phone');
    expect(query).toContain('ORDER BY SUM(sc.balance) DESC');
    expect(query).toContain('LIMIT $2');
  });

  it('los totales cuentan créditos y clientes distintos', () => {
    const query = flat(buildDebtorTotalsSql());

    expect(query).toContain('COUNT(*) AS credits_count');
    expect(query).toContain('COUNT(DISTINCT sc.customer_id) AS customers_count');
  });
});

describe('buildCustomerDebtSubquery', () => {
  it('calcula la deuda desde los créditos, no desde customers.balance', () => {
    // `customers.balance` no se mantiene al día: hay negocios enteros con todos
    // los clientes en 0 debiendo dinero de verdad.
    const query = flat(buildCustomerDebtSubquery('$1'));

    expect(query).toContain('FROM sale_credits sc');
    expect(query).toContain('sc.customer_id = c.id');
    // `\b` evita que `sc.balance` (el saldo del crédito) cuente como acierto.
    expect(query).not.toMatch(/\bc\.balance/);
  });

  it('aplica los mismos filtros que la cartera', () => {
    const query = flat(buildCustomerDebtSubquery('$1'));

    expect(query).toContain('INNER JOIN sale_invoices si');
    expect(query).toContain("si.ticket_type = 'SALE'");
    expect(query).toContain('si.is_deleted = false');
    expect(query).toContain('sc.balance > 0');
  });

  it('usa el placeholder de company que le pasa la query anfitriona', () => {
    expect(flat(buildCustomerDebtSubquery('$4'))).toContain('sc.company_id = $4');
    expect(flat(buildCustomerDebtSubquery('$1'))).not.toContain('sc.company_id = $4');
  });

  it('devuelve 0 y no NULL cuando el cliente no debe nada', () => {
    expect(flat(buildCustomerDebtSubquery('$1'))).toContain('COALESCE(SUM(sc.balance), 0)');
  });
});
