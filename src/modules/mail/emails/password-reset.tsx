import { Button, Section, Text } from '@react-email/components';
import type { JSX } from 'react';

import { EmailLayout } from './components/EmailLayout';
import { theme, text } from './components/theme';

export interface PasswordResetEmailProps {
  /** Nombre de pila de quien pidió el cambio. */
  customer_name: string;
  /** Enlace con el token de un solo uso. Abre PlacePOS. */
  reset_url: string;
}

/**
 * Correo para cambiar la contraseña olvidada.
 *
 * Es el correo más delicado del sistema: quien pulsa ese botón toma el control
 * de la cuenta. Por eso dice tres cosas y ninguna más — que fue una petición,
 * qué hacer, y qué pasa si no fue el destinatario quien la pidió. Sin adornos
 * ni novedades del producto: aquí nadie viene a leer, viene a resolver.
 */
export const PasswordResetEmail = ({
  customer_name,
  reset_url,
}: PasswordResetEmailProps): JSX.Element => (
  <EmailLayout
    preview="Cambia la contraseña de tu cuenta de PlacePos"
    footerNote="Recibes este mensaje porque se pidió un cambio de contraseña para la cuenta de PlacePOS asociada a esta dirección."
  >
    <Text style={{ ...text.eyebrow, color: theme.color.brandLight, marginBottom: '14px' }}>
      Recuperar acceso
    </Text>

    <Text style={{ ...text.title, color: theme.color.fg }}>
      Hola, {customer_name}.
      <br />
      Cambiemos tu contraseña.
    </Text>

    <Text style={{ ...text.body, color: theme.color.fgMuted, marginTop: '18px' }}>
      Pulsa el botón y PlacePos se abrirá para que escribas una contraseña nueva. Si la app no está
      abierta, se inicia sola.
    </Text>

    <Section style={{ padding: '26px 0 6px' }}>
      <Button
        href={reset_url}
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
        Cambiar mi contraseña
      </Button>
    </Section>

    <Text style={{ ...text.caption, color: theme.color.fgFaint, marginTop: '22px' }}>
      El enlace vence en 2 horas y solo sirve una vez. Si el botón no funciona, copia esta dirección
      en tu navegador:
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
      {reset_url}
    </Text>

    {/* Aviso de seguridad: quien no pidió esto necesita saber que está a salvo. */}
    <Section
      style={{
        backgroundColor: theme.color.surface2,
        border: `1px solid ${theme.color.line}`,
        borderRadius: theme.radius.box,
        padding: '14px 18px',
        marginTop: '26px',
      }}
    >
      <Text style={{ ...text.small, color: theme.color.fgMuted }}>
        ¿No pediste este cambio? Ignora este mensaje: tu contraseña actual sigue funcionando y nadie
        puede entrar sin abrir este enlace.
      </Text>
    </Section>
  </EmailLayout>
);

/**
 * Datos con los que `npx email dev` pinta la vista previa. React Email los toma
 * de esta exportación; en producción nunca se usan.
 */
PasswordResetEmail.PreviewProps = {
  customer_name: 'Enrique',
  reset_url:
    'https://placepos.kikedevs.com/restablecer?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
} satisfies PasswordResetEmailProps;

export default PasswordResetEmail;
