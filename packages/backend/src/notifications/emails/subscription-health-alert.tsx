import * as React from 'react';
import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Text,
  Preview,
  Hr,
  Link,
  Img,
  Button,
} from '@react-email/components';

export interface SubscriptionHealthAlertProps {
  provider: string;
  label: string;
  status: 'needs_reconnect' | 'failed';
  message: string;
  testedAt: string;
  timestamp: string;
  providersUrl: string;
  logoUrl?: string;
  consecutiveFailures?: number;
}

export function SubscriptionHealthAlertEmail(props: SubscriptionHealthAlertProps) {
  const {
    provider,
    label,
    status,
    message,
    testedAt,
    providersUrl,
    logoUrl = 'https://app.manifest.build/manifest-logo.png',
    consecutiveFailures = 1,
  } = props;

  const needsReconnect = status === 'needs_reconnect';
  const accentColor = needsReconnect ? '#ea580c' : '#dc2626';
  const accentBg = needsReconnect ? '#fff7ed' : '#fef2f2';
  const accentBorder = needsReconnect ? '#fed7aa' : '#fecaca';

  return (
    <Html>
      <Head />
      <Preview>
        {needsReconnect
          ? `${provider} account “${label}” needs to be relinked`
          : `${provider} account “${label}” is failing health checks`}
      </Preview>
      <Body style={body}>
        <Container style={container}>
          <Section style={logoSection}>
            <Img src={logoUrl} alt="Manifest" height="32" style={logoImg} />
          </Section>

          <Section style={card}>
            <Section style={alertBadgeContainer}>
              <Text style={{ ...alertBadge, color: accentColor, backgroundColor: accentBg }}>
                {needsReconnect ? 'Reconnect needed' : 'Connection failing'}
              </Text>
            </Section>

            <Text style={heading}>
              {needsReconnect
                ? `${provider} account “${label}” needs relinking`
                : `${provider} account “${label}” failed its health check`}
            </Text>
            <Text style={paragraph}>
              {needsReconnect ? (
                <>
                  The stored credential for your <strong>{provider}</strong> account{' '}
                  <strong>{label}</strong> no longer works. Open the provider settings and use the{' '}
                  <strong>Replace</strong> button on that account to sign in again — harnesses using
                  it keep working with no re-adding.
                </>
              ) : (
                <>
                  Your <strong>{provider}</strong> account <strong>{label}</strong> failed its
                  periodic health check
                  {consecutiveFailures > 1 ? ` (${consecutiveFailures} in a row)` : ''}. If it keeps
                  failing, use the <strong>Replace</strong> button on that account to relink it.
                </>
              )}
            </Text>

            <Section style={{ ...detailBox, backgroundColor: accentBg, borderColor: accentBorder }}>
              <Text style={{ ...detailText, color: accentColor }}>{message}</Text>
            </Section>

            <Section style={metaRow}>
              <Text style={metaText}>Provider: {provider}</Text>
              <Text style={metaText}>Account: {label}</Text>
              <Text style={metaText}>Last tested: {testedAt}</Text>
            </Section>

            <Section style={ctaContainer}>
              <Button style={ctaButton} href={providersUrl}>
                Open Provider Settings →
              </Button>
            </Section>
          </Section>

          <Hr style={divider} />
          <Section style={footer}>
            <Text style={footerNote}>
              You are receiving this because a subscription connection on your Manifest tenant needs
              attention.
            </Text>
            <Text style={footerMuted}>
              © 2026 MNFST Inc. All rights reserved.{' '}
              <Link href="https://manifest.build" style={footerLink}>
                manifest.build
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/* ── Brand tokens (mirror threshold-alert.tsx) ─────────────────── */
const brandBg = '#f8f6f1';
const brandCardBg = '#ffffff';
const brandFg = '#020817';
const brandMuted = '#64748b';
const brandBorder = '#e5dfd6';
const brandFont =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const body: React.CSSProperties = {
  backgroundColor: brandBg,
  fontFamily: brandFont,
  margin: 0,
  padding: 0,
};

const container: React.CSSProperties = {
  maxWidth: '520px',
  margin: '0 auto',
  padding: '40px 20px',
};

const logoSection: React.CSSProperties = {
  textAlign: 'center' as const,
  paddingBottom: '32px',
};

const logoImg: React.CSSProperties = {
  margin: '0 auto',
};

const card: React.CSSProperties = {
  backgroundColor: brandCardBg,
  borderRadius: '12px',
  padding: '40px 36px',
  border: `1px solid ${brandBorder}`,
};

const alertBadgeContainer: React.CSSProperties = {
  marginBottom: '16px',
};

const alertBadge: React.CSSProperties = {
  display: 'inline-block',
  fontSize: '11px',
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  padding: '4px 10px',
  borderRadius: '6px',
  margin: 0,
};

const heading: React.CSSProperties = {
  fontSize: '22px',
  fontWeight: 700,
  letterSpacing: '-0.02em',
  color: brandFg,
  margin: '0 0 12px',
  lineHeight: '1.3',
};

const paragraph: React.CSSProperties = {
  fontSize: '15px',
  lineHeight: '1.6',
  color: '#374151',
  margin: '0 0 28px',
};

const detailBox: React.CSSProperties = {
  padding: '12px 16px',
  borderRadius: '8px',
  border: '1px solid',
  marginBottom: '28px',
};

const detailText: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 700,
  margin: 0,
  lineHeight: '1.5',
};

const metaRow: React.CSSProperties = {
  padding: '12px 0 0',
};

const metaText: React.CSSProperties = {
  fontSize: '12px',
  color: brandMuted,
  margin: '0 0 2px',
};

const ctaContainer: React.CSSProperties = {
  textAlign: 'center' as const,
  marginTop: '28px',
};

const ctaButton: React.CSSProperties = {
  backgroundColor: '#0f172a',
  color: '#ffffff',
  fontSize: '14px',
  fontWeight: 600,
  padding: '12px 28px',
  borderRadius: '8px',
  textDecoration: 'none',
  display: 'inline-block',
};

const divider: React.CSSProperties = {
  borderColor: brandBorder,
  borderTop: 'none',
  margin: '32px 0 24px',
};

const footer: React.CSSProperties = {
  textAlign: 'center' as const,
};

const footerNote: React.CSSProperties = {
  fontSize: '12px',
  color: '#94a3b8',
  margin: '0 0 16px',
  lineHeight: '1.5',
};

const footerMuted: React.CSSProperties = {
  fontSize: '12px',
  color: '#94a3b8',
  margin: 0,
};

const footerLink: React.CSSProperties = {
  color: '#94a3b8',
  textDecoration: 'underline',
};
