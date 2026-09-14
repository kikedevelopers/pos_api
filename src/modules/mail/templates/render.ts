import { render } from '@react-email/render';
import type { ReactElement } from 'react';

import type { RenderedEmail } from './test-email.template';

/**
 * Convierte un componente de React Email en lo que el driver necesita: HTML y
 * texto plano.
 *
 * El texto plano NO es opcional: los filtros de spam penalizan los correos que
 * solo traen HTML, y hay clientes (y relojes, y lectores de pantalla) que solo
 * muestran esa parte. Generarlo del mismo árbol garantiza que nunca se queden
 * desincronizados, que es lo que pasa cuando se escriben a mano.
 */
export const renderEmail = async (
  subject: string,
  component: ReactElement,
): Promise<RenderedEmail> => {
  const [html, plainText] = await Promise.all([
    render(component, { pretty: false }),
    render(component, { plainText: true }),
  ]);

  return { subject, html, text: plainText.trim() };
};
