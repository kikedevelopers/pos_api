import { Button, Section, Text } from '@react-email/components';
import type { JSX } from 'react';

import { EmailLayout } from '@/modules/mail/emails/components/EmailLayout';
import { theme, text } from '@/modules/mail/emails/components/theme';

export interface CreditDueTodayEmailProps {
  /** Nombre del negocio. */
  company_name: string;
  /** Fecha legible, p. ej. "03 de octubre de 2026". */
  date_label: string;
  /** Cantidad de créditos que vencen hoy. */
  count: number;
  /** Saldo total que vence hoy, ya formateado (p. ej. "$ 395.000"). */
  total_label: string;
  /** Enlace DIRECTO a la ruta del API que genera y descarga el PDF on-demand. */
  pdf_url: string;
}

/**
 * Alerta de cartera: avisa al administrador que hoy vencen créditos y lo lleva a
 * descargar el detalle en PDF. No lista los créditos en el cuerpo (eso va en el
 * PDF); el correo es solo el aviso + el botón.
 */
export const CreditDueTodayEmail = ({
  company_name,
  date_label,
  count,
  total_label,
  pdf_url,
}: CreditDueTodayEmailProps): JSX.Element => {
  const negocio = company_name.trim();
  const plural = count === 1 ? 'crédito' : 'créditos';

  return (
    <EmailLayout
      preview={`Hoy vencen ${count} ${plural} por ${total_label}`}
      footerNote="Recibes este correo porque las alertas de cartera están activas en PlacePOS."
    >
      <Text style={{ ...text.eyebrow, color: theme.color.brand3, marginBottom: '14px' }}>
        Alerta de cartera
      </Text>

      <Text style={{ ...text.title, color: theme.color.fg }}>
        Hoy vencen {count} {plural}.
      </Text>

      <Text style={{ ...text.body, color: theme.color.fgMuted, marginTop: '18px' }}>
        {negocio ? (
          <>
            En{' '}
            <strong style={{ color: theme.color.fg, fontWeight: 600 }}>{negocio}</strong>, hoy{' '}
          </>
        ) : (
          <>Hoy </>
        )}
        ({date_label}) vence{count === 1 ? '' : 'n'} {count} {plural} con un saldo total de{' '}
        <strong style={{ color: theme.color.fg, fontWeight: 600 }}>{total_label}</strong>.
      </Text>

      <Text style={{ ...text.body, color: theme.color.fgMuted, marginTop: '16px' }}>
        Descarga el detalle completo (cliente, ticket y saldo) en el siguiente enlace:
      </Text>

      <Section style={{ padding: '28px 0 6px' }}>
        <Button
          href={pdf_url}
          style={{
            backgroundColor: theme.color.brand,
            backgroundImage: theme.gradientButton,
            color: theme.color.white,
            fontSize: '15px',
            fontWeight: 600,
            textDecoration: 'none',
            padding: '14px 28px',
            borderRadius: theme.radius.pill,
            display: 'inline-block',
          }}
        >
          Ver y descargar el PDF
        </Button>
      </Section>
    </EmailLayout>
  );
};

CreditDueTodayEmail.PreviewProps = {
  company_name: 'Esencia & Grano',
  date_label: '03 de octubre de 2026',
  count: 3,
  total_label: '$ 395.000',
  pdf_url: 'https://example.com/email-alerts/credit-due-today/pdf?token=preview',
} satisfies CreditDueTodayEmailProps;

export default CreditDueTodayEmail;
