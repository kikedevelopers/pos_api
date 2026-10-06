import PDFDocument from 'pdfkit';

import type { CreditDueTodayRow } from './credits-due-today';

export interface CreditsPdfCompany {
  name: string;
  documentNumber?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface CreditsPdfInput {
  company: CreditsPdfCompany;
  /** Fecha del reporte en formato legible (p. ej. "03 de octubre de 2026"). */
  dateLabel: string;
  rows: CreditDueTodayRow[];
  totalBalance: number;
}

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const money = (n: number): string => COP.format(Math.round(n));

/** 'YYYY-MM-DD' → 'DD/MM/YY' (compacto para la tabla). */
const shortDate = (iso: string): string => {
  const parts = (iso ?? '').split('-');
  if (parts.length !== 3) return iso ?? '';
  const [y, m, d] = parts;
  return `${d}/${m}/${y.slice(2)}`;
};

// Paleta EXACTA del comprobante de compra.
const C_BLACK = '#000000';
const C_TEXT = '#333333';
const C_MUTED = '#555555';
const C_FOOT = '#666666';
const C_LINE = '#cccccc';
const C_LINE2 = '#dddddd';
const DANGER = '#c0392b';

// LETTER + márgenes del comprobante de compra (50 vertical / 60 horizontal).
const MARGIN_X = 60;
const MARGIN_TOP = 50;
const FOOTER_RESERVE = 56;

interface Column {
  key: keyof CreditDueTodayRow | 'n';
  title: string;
  w: number; // fracción del ancho útil
  align: 'left' | 'right';
}

// Orden real y lógico: quién la registró → cliente → ticket → fecha de la venta
// → vencimiento → y luego los montos.
const COLUMNS: Column[] = [
  { key: 'registeredBy', title: 'REGISTRÓ', w: 0.155, align: 'left' },
  { key: 'customerName', title: 'CLIENTE', w: 0.18, align: 'left' },
  { key: 'ticketNumber', title: 'TICKET', w: 0.09, align: 'left' },
  { key: 'saleDate', title: 'FECHA', w: 0.085, align: 'left' },
  { key: 'dueDate', title: 'VENCE', w: 0.085, align: 'left' },
  { key: 'totalAmount', title: 'TOTAL', w: 0.125, align: 'right' },
  { key: 'paidAmount', title: 'ABONADO', w: 0.12, align: 'right' },
  { key: 'balance', title: 'SALDO', w: 0.16, align: 'right' },
];

const CELL_PAD = 4;

/**
 * Genera, EN MEMORIA, el PDF "Créditos que vencen hoy" replicando el look del
 * comprobante de compra (LETTER, Helvetica, header de empresa a dos columnas,
 * tabla sin zebra con separadores finos, caja de totales a la derecha y pie
 * fijo). No se persiste: la ruta tokenizada lo arma a demanda y lo devuelve.
 */
export function buildCreditsDueTodayPdf(input: CreditsPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: MARGIN_TOP, bottom: MARGIN_TOP, left: MARGIN_X, right: MARGIN_X } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = MARGIN_X;
    const right = doc.page.width - MARGIN_X;
    const contentW = right - left;

    // Columnas con x absoluto.
    let acc = left;
    const layout = COLUMNS.map((c) => {
      const width = c.w * contentW;
      const col = { ...c, x: acc, width };
      acc += width;
      return col;
    });

    // ───────────────── Pie fijo (en cada página) ─────────────────
    // Dibujar texto por debajo del margen inferior haría que pdfkit auto-agregue
    // una página → `pageAdded` → recursión infinita. Durante el pie anulamos el
    // margen inferior para que el texto no pagine.
    const drawFooter = (): void => {
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 44;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(C_LINE).stroke();
      doc
        .fillColor(C_TEXT)
        .font('Helvetica-Bold')
        .fontSize(7)
        .text('Generado automáticamente por PlacePOS · Alerta de cartera', left, y + 8, {
          width: contentW,
          align: 'center',
          lineBreak: false,
        });
      doc
        .fillColor(C_FOOT)
        .font('Helvetica')
        .fontSize(7)
        .text('Cifras en pesos colombianos (COP).', left, y + 19, {
          width: contentW,
          align: 'center',
          lineBreak: false,
        });
      doc.page.margins.bottom = savedBottom;
    };
    // Pie de la página 1 (pageAdded NO dispara para la primera); y en las demás.
    drawFooter();
    doc.on('pageAdded', drawFooter);

    // ───────────────── Encabezado ─────────────────
    // Izquierda: empresa.
    let leftY = MARGIN_TOP;
    doc.fillColor(C_BLACK).font('Helvetica-Bold').fontSize(16);
    doc.text(input.company.name || 'Sin nombre de empresa', left, leftY, { width: contentW * 0.6 });
    leftY = doc.y + 4;
    doc.font('Helvetica').fontSize(8).fillColor(C_MUTED);
    const details = [
      input.company.documentNumber ? `NIT: ${input.company.documentNumber}` : null,
      input.company.address || null,
      input.company.phone ? `Tel: ${input.company.phone}` : null,
      input.company.email || null,
    ].filter((d): d is string => Boolean(d));
    for (const d of details) {
      doc.text(d, left, leftY, { width: contentW * 0.6 });
      leftY = doc.y + 1;
    }

    // Derecha: tipo de documento + título + fecha (alineado a la derecha).
    const rx = left + contentW * 0.5;
    const rw = contentW * 0.5;
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(C_BLACK)
      .text('ALERTA DE CARTERA', rx, MARGIN_TOP, { width: rw, align: 'right', characterSpacing: 0.5 });
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(C_BLACK)
      .text('Créditos que vencen hoy', rx, doc.y + 3, { width: rw, align: 'right' });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(C_MUTED)
      .text(input.dateLabel, rx, doc.y + 3, { width: rw, align: 'right' });
    const rightY = doc.y;

    // Borde inferior del header (1pt #333).
    const headerBottom = Math.max(leftY, rightY) + 12;
    doc.moveTo(left, headerBottom).lineTo(right, headerBottom).lineWidth(1).strokeColor(C_TEXT).stroke();

    let y = headerBottom + 18;

    // ───────────────── Cabecera de tabla ─────────────────
    const drawTableHeader = (): void => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C_BLACK);
      for (const col of layout) {
        doc.text(col.title, col.x + (col.align === 'right' ? 0 : 0), y, {
          width: col.width - CELL_PAD,
          align: col.align,
          lineBreak: false,
        });
      }
      y += 16;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(C_TEXT).stroke();
      y += 8;
    };
    drawTableHeader();

    // ───────────────── Filas ─────────────────
    const cell = (col: (typeof layout)[number], text: string, bold: boolean, color: string): void => {
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(8)
        .fillColor(color)
        .text(text, col.x, y, {
          width: col.width - CELL_PAD,
          align: col.align,
          ellipsis: true,
          lineBreak: false,
        });
    };

    for (const row of input.rows) {
      if (y > doc.page.height - MARGIN_TOP - FOOTER_RESERVE) {
        doc.addPage();
        y = MARGIN_TOP;
        drawTableHeader();
      }
      // Valor + estilo por columna; el ORDEN lo decide `COLUMNS`/`layout`.
      const byKey: Record<string, { text: string; bold: boolean; color: string }> = {
        registeredBy: { text: row.registeredBy, bold: false, color: C_TEXT },
        customerName: { text: row.customerName, bold: false, color: C_TEXT },
        ticketNumber: { text: row.ticketNumber, bold: false, color: C_MUTED },
        saleDate: { text: shortDate(row.saleDate), bold: false, color: C_MUTED },
        dueDate: { text: shortDate(row.dueDate), bold: false, color: C_MUTED },
        totalAmount: { text: money(row.totalAmount), bold: false, color: C_TEXT },
        paidAmount: { text: money(row.paidAmount), bold: false, color: C_MUTED },
        balance: { text: money(row.balance), bold: true, color: DANGER },
      };
      for (const col of layout) {
        const v = byKey[col.key];
        if (v) cell(col, v.text, v.bold, v.color);
      }

      y += 17;
      doc.moveTo(left, y - 5).lineTo(right, y - 5).lineWidth(0.5).strokeColor(C_LINE).stroke();
    }

    // ───────────────── Totales (caja a la derecha, 42%) ─────────────────
    if (y > doc.page.height - MARGIN_TOP - FOOTER_RESERVE - 40) {
      doc.addPage();
      y = MARGIN_TOP;
    }
    y += 6;
    const boxW = contentW * 0.42;
    const boxX = right - boxW;

    const totalRow = (label: string, value: string, strong: boolean): void => {
      doc.moveTo(boxX, y).lineTo(right, y).lineWidth(0.5).strokeColor(C_LINE2).stroke();
      y += 4;
      doc
        .font(strong ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(strong ? 9 : 9)
        .fillColor(strong ? C_BLACK : C_MUTED)
        .text(label, boxX, y, { width: boxW * 0.55, align: 'left' });
      doc
        .font('Helvetica-Bold')
        .fontSize(strong ? 11 : 9)
        .fillColor(strong ? C_BLACK : C_TEXT)
        .text(value, boxX + boxW * 0.55, y, { width: boxW * 0.45, align: 'right' });
      y += strong ? 16 : 13;
    };

    totalRow('N° de créditos', String(input.rows.length), false);
    totalRow('Saldo total', money(input.totalBalance), true);

    doc.end();
  });
}
