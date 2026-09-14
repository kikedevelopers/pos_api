import { escapeHtml, renderBaseLayout } from '../templates/base-layout';
import { renderTestEmail } from '../templates/test-email.template';

describe('escapeHtml', () => {
  it('neutraliza los caracteres que rompen el HTML', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("O'Brien & hijos")).toBe('O&#39;Brien &amp; hijos');
  });

  it('escapa el ampersand ANTES que el resto', () => {
    // Al revés produciría `&amp;lt;`, que se ve literal en el correo.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderBaseLayout', () => {
  it('arma un documento HTML completo con el título', () => {
    const html = renderBaseLayout({ title: 'Hola', bodyHtml: '<p>cuerpo</p>' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Hola</title>');
    expect(html).toContain('<p>cuerpo</p>');
    expect(html).toContain('PlacePOS');
  });

  it('escapa el título pero deja pasar el cuerpo ya renderizado', () => {
    const html = renderBaseLayout({
      title: '<b>malo</b>',
      bodyHtml: '<p>confiado</p>',
    });
    expect(html).toContain('&lt;b&gt;malo&lt;/b&gt;');
    expect(html).toContain('<p>confiado</p>');
  });

  it('usa la nota de pie por defecto y respeta la personalizada', () => {
    expect(renderBaseLayout({ title: 't', bodyHtml: '' })).toContain(
      'automáticamente desde PlacePOS',
    );
    expect(renderBaseLayout({ title: 't', bodyHtml: '', footerNote: 'otra cosa' })).toContain(
      'otra cosa',
    );
  });

  it('maqueta con tablas y estilos en línea (los clientes de correo descartan <style>)', () => {
    const html = renderBaseLayout({ title: 't', bodyHtml: '' });
    expect(html).toContain('role="presentation"');
    expect(html).toContain('style="');
    expect(html).not.toContain('<style>');
    expect(html).not.toContain('display:flex');
  });
});

describe('renderTestEmail', () => {
  const data = {
    provider: 'resend',
    environment: 'production',
    from: 'PlacePOS <no-reply@kikedevs.com>',
    sentAtLabel: '12/08/2026 09:41 AM',
  };

  it('incluye los cuatro datos que identifican el origen', () => {
    const email = renderTestEmail(data);
    for (const value of ['resend', 'production', '09:41 AM']) {
      expect(email.html).toContain(value);
      expect(email.text).toContain(value);
    }
    // El remitente lleva ángulos, así que en el HTML va escapado.
    expect(email.html).toContain('no-reply@kikedevs.com');
    expect(email.text).toContain('PlacePOS <no-reply@kikedevs.com>');
  });

  it('el asunto dice de qué entorno viene', () => {
    // Con dos entornos apuntando al mismo buzón es lo único que despeja la duda.
    expect(renderTestEmail(data).subject).toBe('PlacePOS · prueba de envío (production)');
    expect(renderTestEmail({ ...data, environment: 'development' }).subject).toContain(
      'development',
    );
  });

  it('siempre entrega HTML y texto plano', () => {
    const email = renderTestEmail(data);
    expect(email.html).toContain('<!doctype html>');
    // El texto plano no lleva marcado. Los ángulos del remitente
    // (`PlacePOS <no-reply@…>`) sí son legítimos ahí, así que se buscan
    // etiquetas, no el carácter suelto.
    expect(email.text).not.toMatch(/<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i);
    expect(email.text.length).toBeGreaterThan(50);
  });

  it('escapa los datos interpolados en el HTML', () => {
    const email = renderTestEmail({ ...data, from: 'PlacePOS <no-reply@kikedevs.com>' });
    expect(email.html).toContain('&lt;no-reply@kikedevs.com&gt;');
    expect(email.html).not.toContain('<no-reply@kikedevs.com>');
  });
});
