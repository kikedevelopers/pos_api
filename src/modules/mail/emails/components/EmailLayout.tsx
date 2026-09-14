import {
  Body,
  Column,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from '@react-email/components';
import type { JSX, ReactNode } from 'react';

import { logoUrl, theme, text } from './theme';

interface EmailLayoutProps {
  /**
   * Texto de vista previa: lo que se lee en la lista del buzón, junto al
   * asunto, ANTES de abrir el correo. Es el detalle que más gente olvida y el
   * que decide si el correo se abre; sin él, el cliente rellena con el primer
   * texto que encuentra (normalmente "Ver en el navegador" o basura).
   */
  preview: string;
  children: ReactNode;
  /** Línea del pie. Debe explicar POR QUÉ le llegó este correo a quien lo lee. */
  footerNote: string;
}

/**
 * Envoltorio común de todos los correos de PlacePOS: lienzo oscuro, logo,
 * filo de marca, tarjeta y pie.
 *
 * Es el MISMO tema oscuro de la landing. Un correo tiene una sola oportunidad
 * y ningún JavaScript: toda la calidad está en la jerarquía, el aire y la
 * coherencia con la marca. Por eso el shell es compartido — que dos correos se
 * vean distintos entre sí es lo que hace que un producto parezca improvisado.
 */
export const EmailLayout = ({ preview, children, footerNote }: EmailLayoutProps): JSX.Element => (
  <Html lang="es" dir="ltr">
    <Head>
      {/*
        Le dice al cliente que el correo YA viene en oscuro. Sin esto, el modo
        oscuro de Gmail y Outlook reinvierte los colores por su cuenta y
        convierte un diseño cuidado en un amasijo de grises.
      */}
      <meta name="color-scheme" content="dark" />
      <meta name="supported-color-schemes" content="dark" />
    </Head>
    <Preview>{preview}</Preview>
    <Body
      style={{
        margin: 0,
        padding: 0,
        backgroundColor: theme.color.ink,
        fontFamily: theme.fontFamily,
        // Evita que iOS agrande el texto por su cuenta y descuadre la maqueta.
        WebkitTextSizeAdjust: '100%',
      }}
    >
      <Container
        style={{ maxWidth: `${theme.maxWidth}px`, margin: '0 auto', padding: '36px 16px' }}
      >
        {/*
          Membrete: el mismo lockup de la landing (logo + "Place" claro / "Pos"
          violeta). Fuera de la tarjeta, como un papel con sello.
        */}
        <Section style={{ padding: '0 0 22px 2px' }}>
          <Row>
            <Column style={{ width: '42px', verticalAlign: 'middle' }}>
              {/*
                URL pública absoluta porque Gmail descarta las `data:` URIs.
                `alt=""` a propósito: el nombre va en TEXTO justo al lado, así
                que la imagen es decorativa. Con un `alt` de verdad, los muchos
                clientes que bloquean imágenes pintarían un cuadro roto con
                texto cortado; así simplemente no se ve, y el membrete sigue
                leyéndose entero.
              */}
              <Img
                src={logoUrl}
                alt=""
                width="34"
                height="34"
                style={{ display: 'block', borderRadius: '10px' }}
              />
            </Column>
            <Column style={{ verticalAlign: 'middle', paddingLeft: '11px' }}>
              <Text style={{ ...text.wordmark, color: theme.color.fg }}>
                Place<span style={{ color: theme.color.brand }}>Pos</span>
              </Text>
            </Column>
          </Row>
        </Section>

        {/* Tarjeta con filo de marca arriba: el único adorno, y es el de la landing. */}
        <Section
          style={{
            backgroundColor: theme.color.brand,
            backgroundImage: theme.gradient,
            borderRadius: `${theme.radius.card} ${theme.radius.card} 0 0`,
            height: '3px',
            lineHeight: '3px',
            fontSize: '3px',
          }}
        >
          &nbsp;
        </Section>

        <Section
          style={{
            backgroundColor: theme.color.surface,
            border: `1px solid ${theme.color.line}`,
            borderTop: 'none',
            borderRadius: `0 0 ${theme.radius.card} ${theme.radius.card}`,
            padding: '38px 36px 34px',
          }}
        >
          {children}
        </Section>

        <Section style={{ padding: '22px 4px 0' }}>
          <Text style={{ ...text.caption, color: theme.color.fgFaint }}>{footerNote}</Text>
          <Text style={{ ...text.caption, color: theme.color.fgFaint, marginTop: '12px' }}>
            PlacePos · El ERP que pone tu negocio a vender más ·{' '}
            <Link
              href="https://placepos.kikedevs.com"
              style={{ color: theme.color.fgMuted, textDecoration: 'underline' }}
            >
              placepos.kikedevs.com
            </Link>
          </Text>
        </Section>
      </Container>
    </Body>
  </Html>
);
