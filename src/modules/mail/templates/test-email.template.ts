import { escapeHtml, renderBaseLayout } from './base-layout';

export interface TestEmailData {
  /** Driver que envió el correo (`resend`, `smtp`…). */
  provider: string;
  /** Entorno del servidor que lo envió. */
  environment: string;
  /** Remitente configurado. */
  from: string;
  /** Momento del envío, ya formateado para leerse. */
  sentAtLabel: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Correo de prueba que dispara el panel kdevs-admin.
 *
 * Lleva dentro el driver, el entorno y el remitente porque la pregunta real
 * cuando llega no es "¿llegó?" sino "¿llegó desde DÓNDE?": con dos entornos
 * apuntando al mismo buzón es lo único que despeja la duda.
 */
export const renderTestEmail = ({
  provider,
  environment,
  from,
  sentAtLabel,
}: TestEmailData): RenderedEmail => {
  const rows: Array<[string, string]> = [
    ['Proveedor', provider],
    ['Entorno', environment],
    ['Remitente', from],
    ['Enviado', sentAtLabel],
  ];

  const rowsHtml = rows
    .map(
      ([label, value]) => `<tr>
                  <td style="padding:8px 0;font-size:13px;color:#6b6b7b;width:120px;">${escapeHtml(label)}</td>
                  <td style="padding:8px 0;font-size:13px;color:#12121a;font-weight:600;">${escapeHtml(value)}</td>
                </tr>`,
    )
    .join('\n');

  const bodyHtml = `<p style="margin:0 0 16px 0;">
                  Si estás leyendo esto, el servidor de correos de PlacePOS está funcionando: la credencial es válida y el proveedor aceptó el envío.
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e7ee;border-radius:12px;padding:8px 16px;background:#fafaff;">
                  ${rowsHtml}
                </table>
                <p style="margin:16px 0 0 0;font-size:13px;color:#6b6b7b;">
                  Este buzón no recibe respuestas.
                </p>`;

  const text = [
    'Prueba de envío de PlacePOS',
    '',
    'Si estás leyendo esto, el servidor de correos está funcionando: la credencial es válida y el proveedor aceptó el envío.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Este buzón no recibe respuestas.',
  ].join('\n');

  return {
    subject: `PlacePOS · prueba de envío (${environment})`,
    html: renderBaseLayout({
      title: 'Prueba de envío',
      bodyHtml,
      footerNote: 'Correo de prueba disparado desde el panel de administración.',
    }),
    text,
  };
};
