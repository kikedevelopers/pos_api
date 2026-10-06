import type { CreditsDueTodaySummary } from './credits-due-today';

/**
 * Datos MOCK para el botón de prueba (solo dev): tres créditos ficticios que
 * "vencen hoy". Permite validar el correo + el PDF end-to-end sin depender de
 * que existan créditos reales que venzan hoy en la BD.
 */
export function buildMockCreditsDueToday(date: string): CreditsDueTodaySummary {
  const rows = [
    {
      customerName: 'María Gómez',
      ticketNumber: 'VTA-1042',
      saleDate: '2026-09-18',
      registeredBy: 'Ana Torres',
      totalAmount: 180000,
      paidAmount: 80000,
      balance: 100000,
      dueDate: date,
    },
    {
      customerName: 'Carlos Ruiz',
      ticketNumber: 'VTA-1051',
      saleDate: '2026-09-20',
      registeredBy: 'Enrique Pacheco',
      totalAmount: 95000,
      paidAmount: 0,
      balance: 95000,
      dueDate: date,
    },
    {
      customerName: 'Tienda La 28',
      ticketNumber: 'VTA-1066',
      saleDate: '2026-09-03',
      registeredBy: 'Ana Torres',
      totalAmount: 420000,
      paidAmount: 220000,
      balance: 200000,
      dueDate: date,
    },
  ];
  return { date, rows, count: rows.length, totalBalance: 395000 };
}
