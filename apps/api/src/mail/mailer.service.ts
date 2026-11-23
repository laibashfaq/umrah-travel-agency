import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  templateKey?: string;
  userId?: string;
  customerId?: string;
  /** Messages carrying secrets (reset/verification links) never have their body stored in the database. */
  sensitive?: boolean;
}

export type MailOutcome = 'SENT' | 'FAILED' | 'NOT_DELIVERED';

/** Built-in copies so authentication emails work before templates are seeded. Admin-editable versions live in NotificationTemplate. */
const NL = String.fromCharCode(10);
const FALLBACK_TEMPLATES: Record<string, { subject: string; body: string }> = {
  'auth.verify_email': { subject: 'Verify your email address', body: 'Assalamu alaikum {{firstName}},\n\nPlease verify your email address:\n{{link}}\n\nThe link is valid for 24 hours. If you did not create an account, you can ignore this message.' },
  'auth.password_reset': { subject: 'Reset your password', body: 'Assalamu alaikum {{firstName}},\n\nUse this link to choose a new password (valid for 30 minutes):\n{{link}}\n\nIf you did not ask for this, you can ignore this message; your password has not changed.' },
  'auth.already_registered': { subject: 'You already have an account', body: 'Assalamu alaikum {{firstName}},\n\nSomeone (hopefully you) tried to register with this email address, but an account already exists.\nYou can sign in here: {{link}}\nForgot your password? You can reset it from the sign-in page.' },
  'booking.submitted': { subject: 'Booking {{reference}} received', body: 'Assalamu alaikum {{firstName}},' + NL + NL + 'We have received booking {{reference}} for {{packageTitle}}, departing {{departureDate}}. Total: {{amountDue}}.' + NL + 'Our team will contact you with payment instructions.' + NL + 'View your booking: {{link}}' },
  'auth.password_changed': { subject: 'Your password was changed', body: 'Assalamu alaikum {{firstName}},\n\nThe password for your account was just changed. If this was not you, reset your password immediately and contact us.' },
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain text -> minimal branded HTML. URLs become links; everything else is escaped. */
export function textToHtml(subject: string, text: string): string {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) =>
      `<p style="margin:0 0 16px;line-height:1.6">${para.replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#14573f;font-weight:600">$1</a>')}</p>`,
    )
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#f6f4ee;font-family:Arial,Helvetica,sans-serif;color:#1c2b24"><div style="max-width:560px;margin:0 auto;padding:32px 20px"><div style="background:#fff;border-radius:12px;padding:28px"><h1 style="margin:0 0 20px;font-size:20px;color:#14573f">${escapeHtml(subject)}</h1>${body}</div></div></body></html>`;
}

@Injectable()
export class MailerService {
  private readonly log = new Logger(MailerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Renders a template (DB first, built-in fallback) and sends it. Never throws: delivery problems are logged and recorded. */
  async sendTemplate(key: string, to: string, vars: Record<string, string>, ids: { userId?: string; customerId?: string } = {}): Promise<MailOutcome> {
    const row = await this.prisma.notificationTemplate
      .findFirst({ where: { key, channel: 'EMAIL', locale: 'en', isActive: true }, select: { subject: true, body: true } })
      .catch(() => null);
    const tpl = row?.subject && row.body ? { subject: row.subject, body: row.body } : FALLBACK_TEMPLATES[key];
    if (!tpl) {
      this.log.error(`Unknown email template ${key}`);
      return 'FAILED';
    }
    const fill = (s: string) => s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
    const subject = fill(tpl.subject);
    const text = fill(tpl.body);
    return this.send({ to, subject, text, html: textToHtml(subject, text), templateKey: key, sensitive: true, ...ids });
  }

  async send(msg: MailMessage): Promise<MailOutcome> {
    const notification = await this.prisma.notification
      .create({
        data: {
          channel: 'EMAIL',
          status: 'PENDING',
          templateKey: msg.templateKey,
          userId: msg.userId,
          customerId: msg.customerId,
          recipient: msg.to,
          subject: msg.subject,
          body: msg.sensitive ? null : msg.text,
          provider: this.env.EMAIL_PROVIDER,
          attempts: 1,
        },
        select: { id: true },
      })
      .catch((e: unknown) => {
        this.log.error('Could not record notification', e instanceof Error ? e.message : String(e));
        return null;
      });

    let outcome: MailOutcome;
    let providerMessageId: string | undefined;
    let error: string | undefined;
    try {
      if (this.env.EMAIL_PROVIDER === 'resend') {
        providerMessageId = await this.sendViaResend(msg);
        outcome = 'SENT';
      } else {
        await this.writeToOutbox(msg);
        outcome = 'NOT_DELIVERED';
        error = 'Development "log" provider: written to the local outbox, not delivered.';
      }
    } catch (e) {
      outcome = 'FAILED';
      error = e instanceof Error ? e.message.slice(0, 500) : 'Unknown error';
      this.log.error(`Email "${msg.templateKey ?? msg.subject}" failed: ${error}`);
    }

    if (notification) {
      await this.prisma.notification
        .update({
          where: { id: notification.id },
          data: {
            // Only a real provider acknowledgement counts as SENT; the dev outbox is recorded as CANCELLED.
            status: outcome === 'SENT' ? 'SENT' : outcome === 'FAILED' ? 'FAILED' : 'CANCELLED',
            sentAt: outcome === 'SENT' ? new Date() : null,
            providerMessageId,
            lastError: error,
          },
        })
        .catch(() => undefined);
    }
    return outcome;
  }

  private async sendViaResend(msg: MailMessage): Promise<string> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !data.id) throw new Error(`Resend responded ${res.status}${data.message ? `: ${data.message}` : ''}`);
    return data.id;
  }

  /** Development only: every email becomes a JSON file so flows (verification, reset) can be completed locally and in tests. */
  private async writeToOutbox(msg: MailMessage): Promise<void> {
    const root = path.resolve(__dirname, '../../../..');
    const dir = path.isAbsolute(this.env.OUTBOX_DIR) ? this.env.OUTBOX_DIR : path.join(root, this.env.OUTBOX_DIR);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    await writeFile(file, JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.text, template: msg.templateKey, createdAt: new Date().toISOString() }, null, 2));
    this.log.log(`[outbox] ${msg.subject} -> ${msg.to} (${path.relative(root, file)})`);
  }
}
