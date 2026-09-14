import {
  AccountActivatedEmail,
  type AccountActivatedEmailProps,
} from '../emails/account-activated';
import { PasswordChangedEmail, type PasswordChangedEmailProps } from '../emails/password-changed';
import { PasswordResetEmail, type PasswordResetEmailProps } from '../emails/password-reset';
import { WelcomeEmail, type WelcomeEmailProps } from '../emails/welcome';

import { renderEmail } from './render';
import type { RenderedEmail } from './test-email.template';

/**
 * Identificadores estables de las plantillas. Los usa el panel para pedir un
 * envío de prueba, así que renombrar uno rompe el botón: se añaden, no se
 * cambian.
 */
export type EmailTemplateId =
  | 'welcome'
  | 'account-activated'
  | 'password-reset'
  | 'password-changed';

export interface EmailTemplateInfo {
  id: EmailTemplateId;
  /** Nombre para el panel. */
  name: string;
  /** Qué es y cuándo se dispara — lo lee quien va a probarlo. */
  description: string;
  /** Cuándo lo manda la app de verdad. */
  trigger: string;
}

/**
 * CATÁLOGO DE PLANTILLAS.
 *
 * Añadir un correo nuevo = crear su `.tsx` en `emails/`, sumar su id al tipo,
 * una entrada aquí y su rama en `renderSampleEmail`. El panel de kdevs-admin
 * se actualiza solo: la lista sale de aquí, no está escrita en el front.
 */
export const EMAIL_TEMPLATES: readonly EmailTemplateInfo[] = [
  {
    id: 'welcome',
    name: 'Bienvenida',
    description: 'Saluda al dueño, confirma el negocio registrado y lo lleva a activar la cuenta.',
    trigger: 'Al registrarse un owner nuevo en la nube.',
  },
  {
    id: 'account-activated',
    name: 'Cuenta activada',
    description: 'Confirma que la activación salió bien y lo empuja a cargar su catálogo.',
    trigger: 'Al canjear el enlace de activación del correo de bienvenida.',
  },
  {
    id: 'password-reset',
    name: 'Recuperar contraseña',
    description: 'Enlace de un solo uso que abre PlacePos para escribir una contraseña nueva.',
    trigger: 'Al pedir "¿Olvidaste tu contraseña?" desde el inicio de sesión.',
  },
  {
    id: 'password-changed',
    name: 'Contraseña actualizada',
    description: 'Avisa del cambio. Es la alarma de quien NO lo hizo, no una felicitación.',
    trigger: 'Justo después de cambiar la contraseña con el enlace.',
  },
] as const;

/** Datos de muestra de cada plantilla, para las pruebas del panel. */
const SAMPLE_DATA: {
  welcome: WelcomeEmailProps;
  'account-activated': AccountActivatedEmailProps;
  'password-reset': PasswordResetEmailProps;
  'password-changed': PasswordChangedEmailProps;
} = {
  welcome: {
    customer_name: 'Enrique',
    customer_email: 'kike@esenciaygrano.com',
    company_name: 'Esencia & Grano',
    activation_url:
      'https://placepos.kikedevs.com/activar?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
  'account-activated': {
    customer_name: 'Enrique',
    company_name: 'Esencia & Grano',
  },
  'password-reset': {
    customer_name: 'Enrique',
    reset_url:
      'https://placepos.kikedevs.com/restablecer?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  },
  'password-changed': {
    changed_at_label: '12/08/2026 a las 03:41 PM',
  },
};

/** `true` si el id viene del catálogo (validación de entrada del panel). */
export const isEmailTemplateId = (value: string): value is EmailTemplateId =>
  EMAIL_TEMPLATES.some((template) => template.id === value);

/**
 * Renderiza una plantilla con datos de muestra. Es lo que dispara el botón de
 * prueba del panel: se envía el correo REAL, con el mismo código que usa
 * producción, para que lo que se ve en la bandeja sea lo que verá el cliente.
 */
// `async` a propósito aunque el cuerpo no espere nada en el camino de error:
// sin él, un id desconocido lanzaría de forma SÍNCRONA pese a que la firma
// promete un `Promise`, y un `.catch()` del llamador no lo atraparía.
export type EmailSampleOverrides = Partial<
  WelcomeEmailProps & AccountActivatedEmailProps & PasswordResetEmailProps
>;

export const renderSampleEmail = async (
  id: EmailTemplateId,
  overrides: EmailSampleOverrides = {},
): Promise<RenderedEmail> => {
  switch (id) {
    case 'welcome': {
      const props = { ...SAMPLE_DATA.welcome, ...overrides };
      return renderWelcomeEmail(props);
    }
    case 'account-activated': {
      const { customer_name, company_name } = { ...SAMPLE_DATA['account-activated'], ...overrides };
      return renderAccountActivatedEmail({ customer_name, company_name });
    }
    case 'password-reset': {
      const { customer_name, reset_url } = { ...SAMPLE_DATA['password-reset'], ...overrides };
      return renderPasswordResetEmail({ customer_name, reset_url });
    }
    case 'password-changed': {
      return renderPasswordChangedEmail(SAMPLE_DATA['password-changed']);
    }
    default: {
      // Exhaustividad en compilación: añadir un id sin su rama rompe el build.
      const exhaustive: never = id;
      throw new Error(`Plantilla de correo desconocida: ${String(exhaustive)}`);
    }
  }
};

/** Renderiza el correo de bienvenida real (el del registro). */
export const renderWelcomeEmail = (props: WelcomeEmailProps): Promise<RenderedEmail> =>
  renderEmail(`Activa tu cuenta de PlacePOS, ${props.company_name}`, WelcomeEmail(props));

/** Renderiza el aviso de cuenta activada. */
export const renderAccountActivatedEmail = (
  props: AccountActivatedEmailProps,
): Promise<RenderedEmail> =>
  renderEmail('Tu cuenta de PlacePOS ya está activa', AccountActivatedEmail(props));

/** Renderiza el correo con el enlace para cambiar la contraseña. */
export const renderPasswordResetEmail = (props: PasswordResetEmailProps): Promise<RenderedEmail> =>
  renderEmail('Cambia tu contraseña de PlacePOS', PasswordResetEmail(props));

/** Renderiza el aviso de contraseña actualizada. */
export const renderPasswordChangedEmail = (
  props: PasswordChangedEmailProps,
): Promise<RenderedEmail> =>
  renderEmail('Tu contraseña de PlacePOS se actualizó', PasswordChangedEmail(props));
