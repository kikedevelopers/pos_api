import { Button, Column, Row, Section, Text } from '@react-email/components';
import type { JSX } from 'react';

import { EmailLayout } from './components/EmailLayout';
import { theme, text } from './components/theme';

export interface WelcomeEmailProps {
  /** Nombre de pila de quien registró la cuenta. */
  customer_name: string;
  /** Correo con el que inicia sesión. */
  customer_email: string;
  /** Nombre del negocio que quedó registrado. */
  company_name: string;
  /** Enlace de activación con el token de un solo uso. */
  activation_url: string;
}

/** Una fila del bloque de datos de la cuenta. */
const DetailRow = ({
  label,
  value,
  last,
}: {
  label: string;
  value: string;
  last?: boolean;
}): JSX.Element => (
  <Row style={{ borderBottom: last ? 'none' : `1px solid ${theme.color.line}` }}>
    <Column style={{ padding: '12px 0', width: '104px', verticalAlign: 'top' }}>
      <Text style={{ ...text.small, color: theme.color.fgFaint }}>{label}</Text>
    </Column>
    <Column style={{ padding: '12px 0', verticalAlign: 'top' }}>
      {/* `wordBreak` porque un correo largo desborda la tarjeta en móvil. */}
      <Text
        style={{ ...text.small, color: theme.color.fg, fontWeight: 600, wordBreak: 'break-word' }}
      >
        {value}
      </Text>
    </Column>
  </Row>
);

/**
 * Correo de bienvenida: el primer mensaje que PlacePOS le manda a un dueño de
 * negocio, justo después de registrarse.
 *
 * Su trabajo es UNO: que active la cuenta. Sin ese clic no puede entrar, así
 * que todo el correo empuja hacia el botón y no compite con nada más.
 *
 * Decisiones de tono y forma:
 *   - Se le habla por su nombre y se nombra SU negocio. Un correo de bienvenida
 *     que no dice ninguna de las dos cosas es una plantilla, y se nota.
 *   - Los datos de la cuenta van en un bloque aparte, no dentro del párrafo:
 *     es lo que la gente vuelve a buscar meses después ("¿con qué correo
 *     entraba?").
 *   - UN solo botón. Dos llamados a la acción compiten y ninguno gana.
 *   - El enlace también va en texto plano: si el botón no se puede pulsar
 *     (cliente raro, correo reenviado), la activación sigue siendo posible.
 *   - Sin exclamaciones ni confeti. "Distinguido" se consigue con aire,
 *     jerarquía y decir menos, no con adornos.
 */
export const WelcomeEmail = ({
  customer_name,
  customer_email,
  company_name,
  activation_url,
}: WelcomeEmailProps): JSX.Element => (
  <EmailLayout
    preview={`Activa tu cuenta y empieza con ${company_name}`}
    footerNote={`Recibes este mensaje porque se registró la cuenta de ${company_name} en PlacePOS con esta dirección. Si no fuiste tú, ignóralo: sin activar, la cuenta no se puede usar.`}
  >
    <Text style={{ ...text.eyebrow, color: theme.color.brandLight, marginBottom: '14px' }}>
      Bienvenido
    </Text>

    <Text style={{ ...text.title, color: theme.color.fg }}>
      Hola, {customer_name}.
      <br />
      Tu negocio ya está listo.
    </Text>

    <Text style={{ ...text.body, color: theme.color.fgMuted, marginTop: '18px' }}>
      <strong style={{ color: theme.color.fg, fontWeight: 600 }}>{company_name}</strong> quedó
      registrado en PlacePos. Solo falta un paso: confirma que este correo es tuyo y la cuenta queda
      lista para entrar.
    </Text>

    {/* Datos de la cuenta: el bloque al que la gente vuelve meses después. */}
    <Section
      style={{
        backgroundColor: theme.color.surface2,
        border: `1px solid ${theme.color.line}`,
        borderRadius: theme.radius.box,
        padding: '2px 20px',
        margin: '28px 0',
      }}
    >
      <DetailRow label="Negocio" value={company_name} />
      <DetailRow label="Tu correo" value={customer_email} last />
    </Section>

    <Section style={{ padding: '4px 0 6px' }}>
      <Button
        href={activation_url}
        style={{
          // Sólido primero: Outlook ignora el degradado y se queda con este.
          backgroundColor: theme.color.brand,
          backgroundImage: theme.gradientButton,
          color: theme.color.white,
          fontSize: '15px',
          fontWeight: 600,
          textDecoration: 'none',
          padding: '14px 30px',
          borderRadius: theme.radius.pill,
          display: 'inline-block',
        }}
      >
        Activar mi cuenta
      </Button>
    </Section>

    <Text style={{ ...text.caption, color: theme.color.fgFaint, marginTop: '22px' }}>
      El enlace vence en 7 días. Si el botón no funciona, copia esta dirección en tu navegador:
    </Text>
    {/* `wordBreak` obligatorio: la URL lleva un token de 64 caracteres. */}
    <Text
      style={{
        ...text.caption,
        color: theme.color.fgMuted,
        marginTop: '6px',
        wordBreak: 'break-all',
      }}
    >
      {activation_url}
    </Text>
  </EmailLayout>
);

/**
 * Datos con los que `npx email dev` pinta la vista previa. React Email los toma
 * de esta exportación; en producción nunca se usan.
 */
WelcomeEmail.PreviewProps = {
  customer_name: 'Enrique',
  customer_email: 'kike@esenciaygrano.com',
  company_name: 'Esencia & Grano',
  activation_url:
    'https://placepos.kikedevs.com/activar?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} satisfies WelcomeEmailProps;

export default WelcomeEmail;
