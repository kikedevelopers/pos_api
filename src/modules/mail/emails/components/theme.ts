/**
 * Tokens visuales de los correos de PlacePOS.
 *
 * Son los MISMOS valores de la marca que usa la landing (`placepos_lp`,
 * `src/lib/styles/app.css`): lienzo `ink`, superficies elevadas y el acento
 * violeta → azul → cian. El correo no es una pieza suelta, es la continuación
 * de la app: un morado distinto aquí se nota aunque nadie sepa decir por qué.
 *
 * Todo se aplica en línea a propósito: Gmail y Outlook descartan `<style>`,
 * `flex`, `grid` y las variables CSS. Aquí se escribe HTML de correo, no web.
 */

export const theme = {
  color: {
    /* --- Lienzo (idéntico a la landing) --- */
    ink: '#07070b',
    inkSoft: '#0c0c14',
    surface: '#11111c',
    surface2: '#161624',
    line: '#23233a',

    /* --- Texto --- */
    fg: '#f4f4fb',
    fgMuted: '#a6a6c2',
    fgFaint: '#6c6c8a',

    /* --- Marca --- */
    brand: '#7c5cff',
    brand2: '#5b8cff',
    brand3: '#22d3ee',
    /** Violeta claro para texto sobre fondo oscuro: el brand puro no contrasta. */
    brandLight: '#c9bdff',

    white: '#ffffff',
  },
  /**
   * Degradado de marca. Los clientes modernos lo pintan; Outlook lo ignora y
   * cae al `backgroundColor` sólido que SIEMPRE se declara junto a él. Por eso
   * el fallback es el violeta, no un gris: si falla, sigue siendo la marca.
   */
  gradient: 'linear-gradient(90deg, #7c5cff 0%, #5b8cff 55%, #22d3ee 100%)',
  gradientButton: 'linear-gradient(100deg, #7c5cff 0%, #5b8cff 100%)',
  /**
   * Una sola familia, con la pila del sistema. La landing usa Sora + Inter,
   * pero cargar una fuente web en un correo es una apuesta que la mitad de los
   * clientes pierde, y el fallback descuadrado se ve peor que empezar por él.
   */
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  /** 560 px: el ancho donde una línea de texto sigue siendo cómoda de leer. */
  maxWidth: 560,
  radius: {
    card: '18px',
    box: '12px',
    pill: '999px',
  },
} as const;

/**
 * Base de los assets públicos del correo (el logo). Apunta a la landing, que
 * es donde ya viven desplegados. Configurable por si algún día se mueven a un
 * CDN propio.
 *
 * Los correos NO pueden usar `data:` URIs para imágenes: Gmail las descarta.
 * Tiene que ser una URL pública absoluta.
 */
export const assetsBaseUrl = (
  process.env.MAIL_ASSETS_BASE_URL?.trim() || 'https://placepos.kikedevs.com'
).replace(/\/+$/, '');

/**
 * Logo de la app. El default apunta al `logo.png` de la landing porque es el
 * que está PUBLICADO: un default que solo funciona tras configurar una variable
 * es un default roto, y en un correo se ve como un cuadro de imagen partido.
 *
 * PENDIENTE: `placepos_lp/static/logo-email.png` (160 px, ~30 KB) ya existe en
 * el repo de la landing pero todavía no está desplegado. En cuanto se publique,
 * cambiar este default por `logo-email.png`: el original pesa 541 KB, que es
 * mucho para arrastrarlo en cada correo.
 *
 * `MAIL_LOGO_URL` permite apuntar a otro archivo sin tocar código.
 */
export const logoUrl = process.env.MAIL_LOGO_URL?.trim() || `${assetsBaseUrl}/logo.png`;

/** Escala tipográfica. Los saltos son grandes para que la jerarquía se lea sola. */
export const text = {
  eyebrow: {
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase' as const,
    margin: '0',
  },
  wordmark: {
    fontSize: '17px',
    fontWeight: 700,
    letterSpacing: '-0.01em',
    margin: '0',
  },
  title: {
    fontSize: '28px',
    lineHeight: '1.22',
    fontWeight: 700,
    letterSpacing: '-0.025em',
    margin: '0',
  },
  body: {
    fontSize: '15px',
    lineHeight: '1.7',
    margin: '0',
  },
  small: {
    fontSize: '13px',
    lineHeight: '1.6',
    margin: '0',
  },
  caption: {
    fontSize: '12px',
    lineHeight: '1.55',
    margin: '0',
  },
} as const;
