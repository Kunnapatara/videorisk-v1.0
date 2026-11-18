import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  isForbiddenProductionOriginHostname,
  resolveEnvironmentSecurity,
} from '../config/environment';

export interface SmtpResolvedConfig {
  configured: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
  reason?: string;
}

export interface PasswordResetEmailPayload {
  to: string;
  resetUrl: string;
  subject: string;
  text: string;
  html: string;
}

export interface PasswordResetDispatchResult {
  configured: boolean;
  sent: boolean;
  messageId?: string;
  reason?: string;
  error?: string;
}

export interface EmailTransportLike {
  sendMail(mailOptions: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{
    messageId?: string;
    accepted?: unknown[];
    rejected?: unknown[];
    response?: string;
  }>;
  close?: () => void;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeEmailLogText(
  rawMessage: unknown,
  secrets: Array<string | undefined | null> = []
): string {
  let msg = rawMessage instanceof Error ? rawMessage.message : String(rawMessage || 'Unknown SMTP error');
  for (const secret of secrets) {
    if (secret && secret.trim().length > 0) {
      msg = msg.split(secret).join('[REDACTED]');
    }
  }
  msg = msg.replace(/resetToken=[A-Za-z0-9%._-]+/gi, 'resetToken=[REDACTED]');
  msg = msg.replace(/\b[a-f0-9]{48,}\b/gi, '[REDACTED_TOKEN]');
  return msg.slice(0, 240);
}

export function resolveSmtpConfiguration(
  env: NodeJS.ProcessEnv = process.env
): SmtpResolvedConfig {
  const host = (env.SMTP_HOST || '').trim();
  if (!host) {
    return { configured: false, reason: 'SMTP_NOT_CONFIGURED' };
  }

  const rawUser = env.SMTP_USER !== undefined ? env.SMTP_USER.trim() : '';
  const rawPass = env.SMTP_PASS !== undefined ? env.SMTP_PASS.trim() : '';

  // Reject half-configured auth credentials fail-closed
  if ((rawUser && !rawPass) || (!rawUser && rawPass)) {
    return {
      configured: false,
      host,
      reason: 'SMTP_AUTH_INCOMPLETE',
    };
  }

  const rawSecure = (env.SMTP_SECURE || '').trim().toLowerCase();
  const rawPort = (env.SMTP_PORT || '').trim();
  let port = rawSecure === 'true' ? 465 : 587;
  if (rawPort) {
    if (!/^\d+$/.test(rawPort)) {
      return { configured: false, host, reason: 'INVALID_SMTP_PORT' };
    }
    const parsedPort = Number(rawPort);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      return { configured: false, host, reason: 'INVALID_SMTP_PORT' };
    }
    port = parsedPort;
  }

  let secure = port === 465;
  if (rawSecure === 'true') {
    secure = true;
  } else if (rawSecure === 'false') {
    secure = false;
  } else if (rawSecure !== '') {
    return { configured: false, host, reason: 'INVALID_SMTP_SECURE' };
  }

  const configuredFrom = (env.SMTP_FROM || env.EMAIL_FROM || '').trim();
  const fallbackFrom = rawUser && rawUser.includes('@') ? `VideoRisk <${rawUser}>` : '';
  const from = configuredFrom || fallbackFrom;

  if (!from) {
    return {
      configured: false,
      host,
      port,
      secure,
      reason: 'MISSING_SMTP_FROM',
    };
  }

  // Reject header injection characters in From address
  if (/[\r\n]/.test(from)) {
    return {
      configured: false,
      host,
      port,
      secure,
      reason: 'INVALID_SMTP_FROM',
    };
  }

  return {
    configured: true,
    host,
    port,
    secure,
    ...(rawUser ? { user: rawUser, pass: rawPass } : {}),
    from,
  };
}

export function resolvePasswordResetAppBaseUrl(
  env: NodeJS.ProcessEnv = process.env
): { valid: boolean; origin?: string; reason?: string } {
  const envSec = resolveEnvironmentSecurity(env);
  const rawBase = (env.APP_BASE_URL || env.APP_URL || env.PUBLIC_APP_URL || '').trim();

  if (!rawBase) {
    if (envSec.isProduction) {
      return {
        valid: false,
        reason: 'MISSING_APP_BASE_URL',
      };
    }
    return {
      valid: true,
      origin: 'http://localhost:3000',
    };
  }

  if (rawBase.startsWith('//') || rawBase.includes('@') || /\s/.test(rawBase) || rawBase.includes('\\')) {
    return {
      valid: false,
      reason: 'INVALID_APP_BASE_URL',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    return {
      valid: false,
      reason: 'INVALID_APP_BASE_URL',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reason: 'INVALID_APP_BASE_URL',
    };
  }

  if (envSec.isProduction) {
    if (parsed.protocol !== 'https:' || isForbiddenProductionOriginHostname(parsed.hostname)) {
      return {
        valid: false,
        reason: 'INSECURE_OR_FORBIDDEN_APP_BASE_URL',
      };
    }
  } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      reason: 'INVALID_APP_BASE_URL',
    };
  }

  return {
    valid: true,
    origin: parsed.origin,
  };
}

export function buildPasswordResetEmailContent(params: {
  recipientEmail: string;
  resetToken: string;
  appOrigin: string;
  expiresInMinutes?: number;
}): PasswordResetEmailPayload {
  const expiresInMinutes = params.expiresInMinutes ?? 60;
  const expiryLabel = expiresInMinutes === 60 ? '1 hour' : `${expiresInMinutes} minutes`;
  const cleanOrigin = params.appOrigin.replace(/\/+$/, '');
  const resetUrl = `${cleanOrigin}/?resetToken=${encodeURIComponent(params.resetToken)}`;
  const safeRecipient = escapeHtml(params.recipientEmail);
  const safeResetUrl = escapeHtml(resetUrl);

  const subject = 'Reset your VideoRisk password';
  const text = [
    'VideoRisk — Password Reset Request',
    '',
    `Account: ${params.recipientEmail}`,
    '',
    'We received a request to reset the password for your VideoRisk account.',
    'Use the link below to choose a new password:',
    '',
    resetUrl,
    '',
    `This link expires in ${expiryLabel} and can only be used once.`,
    'If you did not request a password reset, you can safely ignore this email — your password will remain unchanged.',
  ].join('\n');

  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1917;">',
    '<h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#1c1917;">VideoRisk Password Reset</h2>',
    `<p style="margin:0 0 16px;font-size:14px;color:#57534e;">Account: <strong>${safeRecipient}</strong></p>`,
    '<p style="margin:0 0 20px;font-size:14px;line-height:1.5;">We received a request to reset your VideoRisk account password. Click the link below to set a new password:</p>',
    `<p style="margin:0 0 24px;"><a href="${safeResetUrl}" style="display:inline-block;padding:12px 20px;background:#1c1917;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;">Reset Password</a></p>`,
    `<p style="margin:0 0 12px;font-size:12px;color:#57534e;word-break:break-all;">Direct link: <a href="${safeResetUrl}">${safeResetUrl}</a></p>`,
    `<p style="margin:0 0 12px;font-size:13px;color:#57534e;">This reset link expires in <strong>${expiryLabel}</strong> and can only be used once.</p>`,
    '<p style="margin:0;font-size:13px;color:#78716c;">If you did not request a password reset, you can safely ignore this email.</p>',
    '</div>',
  ].join('');

  return {
    to: params.recipientEmail,
    resetUrl,
    subject,
    text,
    html,
  };
}

export class EmailService {
  private testTransportFactory: ((config: SmtpResolvedConfig) => EmailTransportLike) | null = null;

  public setTransportFactoryForTest(
    factory: ((config: SmtpResolvedConfig) => EmailTransportLike) | null
  ): void {
    this.testTransportFactory = factory;
  }

  private createNodemailerTransport(config: SmtpResolvedConfig): EmailTransportLike {
    if (this.testTransportFactory) {
      return this.testTransportFactory(config);
    }
    const transport: Transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user && config.pass
        ? { auth: { user: config.user, pass: config.pass } }
        : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    return transport as unknown as EmailTransportLike;
  }

  public async sendPasswordResetEmail(
    params: {
      recipientEmail: string;
      resetToken: string;
      expiresInMinutes?: number;
    },
    env: NodeJS.ProcessEnv = process.env
  ): Promise<PasswordResetDispatchResult> {
    const smtpConfig = resolveSmtpConfiguration(env);
    if (!smtpConfig.configured || !smtpConfig.from) {
      return {
        configured: false,
        sent: false,
        reason: smtpConfig.reason || 'SMTP_NOT_CONFIGURED',
      };
    }

    const baseUrlResolution = resolvePasswordResetAppBaseUrl(env);
    if (!baseUrlResolution.valid || !baseUrlResolution.origin) {
      const reason = baseUrlResolution.reason || 'INVALID_APP_BASE_URL';
      console.error(`[EmailService] Password reset email skipped due to origin configuration (${reason}).`);
      return {
        configured: true,
        sent: false,
        reason,
        error: `Password reset base URL configuration invalid (${reason}).`,
      };
    }

    const emailPayload = buildPasswordResetEmailContent({
      recipientEmail: params.recipientEmail,
      resetToken: params.resetToken,
      appOrigin: baseUrlResolution.origin,
      expiresInMinutes: params.expiresInMinutes ?? 60,
    });

    let transport: EmailTransportLike | null = null;
    try {
      transport = this.createNodemailerTransport(smtpConfig);
      const info = await transport.sendMail({
        from: smtpConfig.from,
        to: emailPayload.to,
        subject: emailPayload.subject,
        text: emailPayload.text,
        html: emailPayload.html,
      });

      const rejected = Array.isArray(info?.rejected) ? info.rejected.map(String) : [];
      const accepted = Array.isArray(info?.accepted) ? info.accepted.map(String) : [];
      if (
        rejected.some((r) => r.toLowerCase() === emailPayload.to.toLowerCase()) &&
        !accepted.some((a) => a.toLowerCase() === emailPayload.to.toLowerCase())
      ) {
        console.error('[EmailService] SMTP server rejected password reset recipient.');
        return {
          configured: true,
          sent: false,
          reason: 'SMTP_RECIPIENT_REJECTED',
          error: 'SMTP server rejected recipient.',
        };
      }

      console.log(
        `[EmailService] Password reset email dispatched via SMTP (host=${smtpConfig.host}, messageId=${info?.messageId || 'accepted'}).`
      );
      return {
        configured: true,
        sent: true,
        messageId: info?.messageId,
      };
    } catch (err: any) {
      const safeMsg = sanitizeEmailLogText(err, [
        smtpConfig.pass,
        smtpConfig.user,
        params.resetToken,
      ]);
      console.error(`[EmailService] Password reset email delivery failed: ${safeMsg}`);
      return {
        configured: true,
        sent: false,
        reason: 'SMTP_DELIVERY_FAILED',
        error: safeMsg,
      };
    } finally {
      try {
        if (transport && typeof transport.close === 'function') {
          transport.close();
        }
      } catch {
        // Ignore transport close errors
      }
    }
  }
}

export const emailService = new EmailService();
