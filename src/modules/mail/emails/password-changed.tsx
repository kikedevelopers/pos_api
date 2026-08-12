import { Section, Text } from '@react-email/components';
import type { JSX } from 'react';

import { EmailLayout } from './components/EmailLayout';
import { theme, text } from './components/theme';

export interface PasswordChangedEmailProps {
  /** Momento del cambio, ya formateado en hora de Colombia. */
  changed_at_label: string;
}

/**
 * Aviso de contraseña actualizada.
 *
 * No es una felicitación: es una ALARMA para quien no hizo el cambio. Por eso
 * no lleva botón — quien sí lo hizo ya está dentro de la app y no necesita
 * ninguna acción, y quien no, lo que necesita es avisarnos, no pulsar nada.
 * Un correo así es lo único que separa una cuenta robada en silencio de una
 * que su dueño puede recuperar el mismo día.
 */
export const PasswordChangedEmail = ({
  changed_at_label,
}: PasswordChangedEmailProps): JSX.Element => (
  <EmailLayout
    preview="Tu contraseña de PlacePos se actualizó"
    footerNote="Recibes este mensaje porque la contraseña de la cuenta de PlacePOS asociada a esta dirección acaba de cambiar."
  >
    <Text style={{ ...text.eyebrow, color: theme.color.brand3, marginBottom: '14px' }}>
      Contraseña actualizada
    </Text>

    <Text style={{ ...text.title, color: theme.color.fg }}>Listo, tu contraseña cambió.</Text>

    <Text style={{ ...text.body, color: theme.color.fgMuted, marginTop: '18px' }}>
      El cambio se hizo el <strong style={{ color: theme.color.fg }}>{changed_at_label}</strong>. Ya
      puedes iniciar sesión en PlacePos con tu contraseña nueva.
    </Text>

    <Section
      style={{
        backgroundColor: theme.color.surface2,
        border: `1px solid ${theme.color.line}`,
        borderRadius: theme.radius.box,
        padding: '16px 18px',
        marginTop: '26px',
      }}
    >
      <Text style={{ ...text.small, color: theme.color.fg, fontWeight: 600 }}>¿No fuiste tú?</Text>
      <Text style={{ ...text.small, color: theme.color.fgMuted, marginTop: '6px' }}>
        Escríbenos por WhatsApp al +57 311 732 3107 lo antes posible. Alguien más tiene acceso a tu
        correo y hay que asegurar la cuenta.
      </Text>
    </Section>
  </EmailLayout>
);

/**
 * Datos con los que `npx email dev` pinta la vista previa. React Email los toma
 * de esta exportación; en producción nunca se usan.
 */
PasswordChangedEmail.PreviewProps = {
  changed_at_label: '12/08/2026 a las 03:41 PM',
} satisfies PasswordChangedEmailProps;

export default PasswordChangedEmail;
