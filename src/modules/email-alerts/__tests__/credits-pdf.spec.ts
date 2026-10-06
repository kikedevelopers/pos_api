import { buildCreditsDueTodayPdf } from '../internal/credits-pdf';

const company = {
  name: 'Esencia & Grano',
  documentNumber: '900123456-7',
  address: 'Calle 28 # 10-20',
  phone: '3001234567',
  email: 'hola@esencia.co',
};

describe('buildCreditsDueTodayPdf', () => {
  it('genera un Buffer PDF válido (cabecera %PDF)', async () => {
    const buffer = await buildCreditsDueTodayPdf({
      company,
      dateLabel: '03 de octubre de 2026',
      rows: [
        {
          customerName: 'María Gómez',
          ticketNumber: 'VTA-1042',
          saleDate: '2026-09-18',
          registeredBy: 'Ana Torres',
          totalAmount: 180000,
          paidAmount: 80000,
          balance: 100000,
          dueDate: '2026-10-03',
        },
      ],
      totalBalance: 100000,
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('funciona sin filas (reporte vacío) sin lanzar', async () => {
    const buffer = await buildCreditsDueTodayPdf({
      company: { name: 'X' },
      dateLabel: '03 de octubre de 2026',
      rows: [],
      totalBalance: 0,
    });
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('funciona con muchas filas (multi-página) sin lanzar', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      customerName: `Cliente ${i}`,
      ticketNumber: `VTA-${1000 + i}`,
      saleDate: '2026-09-18',
      registeredBy: 'Ana Torres',
      totalAmount: 100000,
      paidAmount: 40000,
      balance: 60000,
      dueDate: '2026-10-03',
    }));
    const buffer = await buildCreditsDueTodayPdf({
      company,
      dateLabel: '03 de octubre de 2026',
      rows,
      totalBalance: 3600000,
    });
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(2000);
  });
});
