/**
 * Envoltorio HTML de todos los correos de PlacePOS.
 *
 * Tablas y estilos EN LÍNEA a propósito: Gmail, Outlook y compañía descartan
 * `<style>`, flexbox y grid. Un correo bonito en el navegador que llega roto al
 * cliente no sirve de nada, así que aquí se escribe HTML de correo, no HTML web.
 */

/** Escapa el texto que va dentro del HTML del correo. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface BaseLayoutOptions {
  /** Título grande del correo. */
  title: string;
  /** Cuerpo ya en HTML (los datos que se interpolen deben venir escapados). */
  bodyHtml: string;
  /** Línea pequeña al pie, bajo la firma. */
  footerNote?: string;
}

const BRAND = '#7c5cff';
const INK = '#12121a';
const MUTED = '#6b6b7b';
const BORDER = '#e7e7ee';
const CANVAS = '#f5f5fa';

/** Arma el HTML completo del correo a partir de un cuerpo. */
export const renderBaseLayout = ({
  title,
  bodyHtml,
  footerNote,
}: BaseLayoutOptions): string => `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${CANVAS};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <span style="display:inline-block;font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${BRAND};">PlacePOS</span>
                <h1 style="margin:12px 0 0 0;font-size:22px;line-height:1.3;color:${INK};font-weight:700;">${escapeHtml(title)}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px;font-size:15px;line-height:1.6;color:${INK};">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;border-top:1px solid ${BORDER};background:#fafaff;">
                <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};">
                  ${escapeHtml(footerNote ?? 'Este mensaje se envió automáticamente desde PlacePOS.')}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
