import {
  EMAIL_TEMPLATES,
  isEmailTemplateId,
  renderSampleEmail,
  renderWelcomeEmail,
} from '../templates/template-catalog';

const ACTIVATION_URL =
  'https://placepos.kikedevs.com/activar?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const PROPS = {
  customer_name: 'Enrique',
  customer_email: 'kike@esenciaygrano.com',
  company_name: 'Esencia & Grano',
  activation_url: ACTIVATION_URL,
};

describe('correo de bienvenida', () => {
  it('lleva los tres datos del cliente en el HTML y en el texto', async () => {
    // Es el motivo de existir de este correo: un mensaje que no nombra a la
    // persona ni a su negocio es una plantilla, y se nota.
    const email = await renderWelcomeEmail(PROPS);

    expect(email.html).toContain('Enrique');
    expect(email.html).toContain('kike@esenciaygrano.com');
    expect(email.text).toContain('Enrique');
    expect(email.text).toContain('kike@esenciaygrano.com');
    expect(email.text).toContain('Esencia & Grano');
  });

  it('escapa el HTML de los datos interpolados', async () => {
    // El nombre del negocio lo escribe el cliente al registrarse: es entrada
    // de usuario y va dentro de un correo que se manda a terceros.
    const email = await renderWelcomeEmail({
      ...PROPS,
      company_name: '<script>alert(1)</script> & Cía',
    });

    expect(email.html).not.toContain('<script>alert(1)</script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.html).toContain('&amp;');
  });

  it('el asunto dice lo que hay que hacer y nombra el negocio', async () => {
    const email = await renderWelcomeEmail(PROPS);
    expect(email.subject).toBe('Activa tu cuenta de PlacePOS, Esencia & Grano');
  });

  it('el enlace de activación va en el botón Y en texto', async () => {
    // Si el botón no se puede pulsar (cliente raro, correo reenviado como
    // texto), la activación tiene que seguir siendo posible: sin ese enlace la
    // cuenta queda inservible.
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html).toContain(ACTIVATION_URL);
    expect(email.html).toContain('Activar mi cuenta');
    expect(email.text).toContain(ACTIVATION_URL);
  });

  it('avisa de que el enlace vence', async () => {
    const email = await renderWelcomeEmail(PROPS);
    expect(email.text).toContain('7 días');
  });

  it('entrega HTML completo y texto plano sin marcado', async () => {
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html).toMatch(/^<!DOCTYPE html/i);
    expect(email.text.length).toBeGreaterThan(100);
    expect(email.text).not.toMatch(/<\/?(html|body|table|div|p|span)\b/i);
  });

  it('incluye el texto de vista previa del buzón', async () => {
    // Sin `Preview`, el cliente de correo rellena la línea del buzón con el
    // primer texto que encuentre, que suele ser basura.
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html).toContain('Activa tu cuenta y empieza con Esencia &amp; Grano');
  });

  it('lleva UN solo botón de acción', async () => {
    // Dos llamados a la acción compiten y ninguno gana. Este correo solo pide
    // una cosa: activar.
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html.match(/<a[^>]+href="[^"]*activar[^"]*"/gi) ?? []).toHaveLength(1);
    expect(email.html).not.toContain('/docs');
  });

  it('explica en el pie por qué recibe el correo', async () => {
    // Requisito de cualquier correo transaccional serio (y de los filtros de
    // spam): quien lo recibe debe entender por qué le llegó.
    const email = await renderWelcomeEmail(PROPS);
    expect(email.text).toContain('Recibes este mensaje porque');
  });

  it('no arrastra estilos que los clientes de correo descartan', async () => {
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html).not.toContain('display:flex');
    expect(email.html).not.toContain('display:grid');
    expect(email.html).not.toContain('var(--');
  });

  it('usa la paleta oscura de la landing', async () => {
    // Los mismos tokens de `placepos_lp/src/lib/styles/app.css`. Que el correo
    // y la web usen morados distintos se nota aunque nadie sepa decir por qué.
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html).toContain('#07070b'); // lienzo `ink`
    expect(email.html).toContain('#11111c'); // superficie de la tarjeta
    expect(email.html).toContain('#7c5cff'); // marca
  });

  it('declara el esquema oscuro para que el cliente no reinvierta los colores', async () => {
    // Sin esto, el modo oscuro de Gmail y Outlook repinta por su cuenta y
    // convierte el diseño en un amasijo de grises.
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html).toContain('color-scheme');
    expect(email.html).toContain('supported-color-schemes');
  });

  it('lleva el logo como URL absoluta y el nombre en TEXTO', async () => {
    // Gmail descarta las `data:` URIs, así que el logo DEBE ser una URL
    // pública. Y como muchos clientes bloquean imágenes, el membrete no puede
    // depender de ella: el nombre va en texto, con el mismo lockup bicolor de
    // la landing, y la imagen queda decorativa (`alt=""`) para que un logo
    // bloqueado no pinte un cuadro roto con texto cortado.
    const email = await renderWelcomeEmail(PROPS);
    expect(email.html).toMatch(/<img[^>]+src="https:\/\/[^"]+"/i);
    expect(email.html).toMatch(/<img[^>]+alt=""/i);
    expect(email.html).not.toContain('src="data:');
    expect(email.html).toContain('Place<span style="color:#7c5cff">Pos</span>');
  });

  it('cada degradado lleva su color sólido de respaldo en el MISMO style', async () => {
    // Outlook ignora `background-image`: sin un `background-color` en el mismo
    // atributo, el filo de marca y el botón se quedarían transparentes.
    const email = await renderWelcomeEmail(PROPS);

    const styles = [...email.html.matchAll(/style="([^"]*)"/g)].map((match) => match[1]);
    const withGradient = styles.filter((style) => style.includes('linear-gradient'));

    expect(withGradient.length).toBeGreaterThan(0);
    for (const style of withGradient) {
      expect(style).toMatch(/background-color:#[0-9a-f]{6}/i);
    }
  });

  it('sobrevive a nombres largos o con acentos sin romper el render', async () => {
    const email = await renderWelcomeEmail({
      customer_name: 'María José',
      customer_email: 'maria.jose+pruebas@correo-muy-largo-de-verdad.com.co',
      company_name: 'Distribuidora Ñandú & Compañía Ltda.',
      activation_url: ACTIVATION_URL,
    });
    expect(email.html).toContain('María José');
    expect(email.html).toContain('Ñandú');
    expect(email.subject).toContain('Ñandú');
  });
});

describe('catálogo de plantillas', () => {
  it('expone la bienvenida con su descripción y disparador', () => {
    const welcome = EMAIL_TEMPLATES.find((template) => template.id === 'welcome');
    expect(welcome).toBeDefined();
    expect(welcome?.name).toBe('Bienvenida');
    expect(welcome?.trigger.length).toBeGreaterThan(0);
  });

  it('no tiene ids repetidos', () => {
    // Los ids son la llave que manda el panel: un duplicado enviaría el correo
    // equivocado sin que nada falle.
    const ids = EMAIL_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('valida los ids que llegan del panel', () => {
    expect(isEmailTemplateId('welcome')).toBe(true);
    for (const bad of ['', 'Welcome', 'bienvenida', 'welcome ', '../etc/passwd']) {
      expect(isEmailTemplateId(bad)).toBe(false);
    }
  });

  it('NINGUNA plantilla invita a responder el correo', async () => {
    // Los correos salen de `no-reply@`: pedirle a alguien que conteste manda su
    // mensaje a un buzón que no lee nadie. Este test cubre todo el catálogo
    // para que una plantilla futura no vuelva a prometerlo.
    const prohibidas = [
      /respond[ea]\s+(a\s+)?(este|el)\s+(correo|mensaje|email)/i,
      /contest[ae]\s+(a\s+)?(este|el)\s+(correo|mensaje|email)/i,
      /respondiendo\s+a\s+(este|el)/i,
      /(escríbenos|escribenos)\s+(a\s+)?(este|aquí\s+mismo)/i,
    ];

    for (const template of EMAIL_TEMPLATES) {
      const email = await renderSampleEmail(template.id);
      for (const patron of prohibidas) {
        expect(email.text).not.toMatch(patron);
        expect(email.html).not.toMatch(patron);
      }
    }
  });

  it('renderiza cada plantilla del catálogo con datos de muestra', async () => {
    // Blindaje: si alguien añade una plantilla al catálogo y olvida su rama en
    // `renderSampleEmail`, este test la caza antes que el botón del panel.
    for (const template of EMAIL_TEMPLATES) {
      const email = await renderSampleEmail(template.id);
      expect(email.subject.length).toBeGreaterThan(0);
      expect(email.html).toMatch(/^<!DOCTYPE html/i);
      expect(email.text.length).toBeGreaterThan(0);
    }
  });

  it('la muestra admite sobreescribir datos', async () => {
    const email = await renderSampleEmail('welcome', { company_name: 'Mi Tienda' });
    expect(email.subject).toContain('Mi Tienda');
    // Lo no sobreescrito conserva la muestra.
    expect(email.html).toContain('Enrique');
  });

  it('falla ruidosamente ante una plantilla desconocida', async () => {
    await expect(
      renderSampleEmail('inexistente' as Parameters<typeof renderSampleEmail>[0]),
    ).rejects.toThrow('Plantilla de correo desconocida: inexistente');
  });
});
