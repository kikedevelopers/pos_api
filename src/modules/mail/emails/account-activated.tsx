import { Button, Section, Text } from '@react-email/components';
import type { JSX } from 'react';

import { EmailLayout } from './components/EmailLayout';
import { theme, text } from './components/theme';

export interface AccountActivatedEmailProps {
  /** Nombre de pila de quien activó la cuenta. */
  customer_name: string;
  /** Nombre del negocio. Puede venir vacío si la cuenta no tiene company. */
  company_name: string;
}

/**
 * Confirmación de activación: el segundo (y último) correo del alta.
 *
 * Es el correo que cierra el trámite y abre el uso. Por eso NO repite la
 * bienvenida ni vuelve a listar los datos de la cuenta: eso ya se dijo, y
 * repetirlo haría que el mensaje pareciera un duplicado y se ignorara. Aquí
 * solo hay dos cosas — "ya puedes entrar" y por dónde empezar.
 */
export const AccountActivatedEmail = ({
  customer_name,
  company_name,
}: AccountActivatedEmailProps): JSX.Element => {
  const negocio = company_name.trim();

  return (
    <EmailLayout
      preview="Tu cuenta quedó activa: ya puedes entrar a PlacePos"
      footerNote="Recibes este mensaje porque acabas de activar tu cuenta de PlacePOS con esta dirección."
    >
      <Text style={{ ...text.eyebrow, color: theme.color.brand3, marginBottom: '14px' }}>
        Cuenta activa
      </Text>

      <Text style={{ ...text.title, color: theme.color.fg }}>
        Listo, {customer_name}.
        <br />
        Ya puedes entrar.
      </Text>

      <Text style={{ ...text.body, color: theme.color.fgMuted, marginTop: '18px' }}>
        {negocio ? (
          <>
            La cuenta de{' '}
            <strong style={{ color: theme.color.fg, fontWeight: 600 }}>{negocio}</strong> quedó
            activada.{' '}
          </>
        ) : (
          <>Tu cuenta quedó activada. </>
        )}
        Inicia sesión en PlacePos con tu correo y la contraseña que elegiste al registrarte.
      </Text>

      <Text style={{ ...text.body, color: theme.color.fgMuted, marginTop: '16px' }}>
        Lo primero es cargar tus productos. Con el catálogo montado, cada venta ya descuenta el
        stock y alimenta tus informes sola.
      </Text>

      <Section style={{ padding: '28px 0 6px' }}>
        <Button
          href="https://placepos.kikedevs.com/docs"
          style={{
            // Sólido primero: Outlook ignora el degradado y se queda con este.
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
          Cómo dar los primeros pasos
        </Button>
      </Section>
    </EmailLayout>
  );
};

/**
 * Datos con los que `npx email dev` pinta la vista previa. React Email los toma
 * de esta exportación; en producción nunca se usan.
 */
AccountActivatedEmail.PreviewProps = {
  customer_name: 'Enrique',
  company_name: 'Esencia & Grano',
} satisfies AccountActivatedEmailProps;

export default AccountActivatedEmail;
