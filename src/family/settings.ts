import { z } from 'zod';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
export class DomainError extends HttpException {
  constructor(
    readonly code: string,
    status: number,
  ) {
    super(
      {
        code,
        message:
          status === 409
            ? 'This record changed. Reload and try again.'
            : status === 503
              ? 'Family features are unavailable.'
              : status === 404
                ? 'Record not found.'
                : 'Request cannot be completed.',
      },
      status,
    );
  }
}
export class FamilySettings {
  readonly enabled: boolean;
  readonly activeKey: string;
  readonly keys: Record<string, string>;
  readonly noticeVersion: string;
  readonly caseDays: number;
  readonly consentDays: number;
  readonly maxAttempts: number;
  readonly mfaSeconds: number;
  readonly requestLimit: number;
  constructor(input: Record<string, unknown> = process.env) {
    const schema = z.object({
      PHASE2_ENABLED: z.enum(['true', 'false']).default('false'),
      PHASE2_ACTIVE_KEY_ID: z
        .string()
        .regex(/^v\d+$/)
        .default('v1'),
      PHASE2_DATA_KEYS: z.string().default('{}'),
      PHASE2_NOTICE_VERSION: z.string().min(1).max(80).default('development-2026-10-10'),
      PHASE2_CASE_DAYS: z.coerce.number().int().min(1).max(365).default(14),
      PHASE2_CONSENT_DAYS: z.coerce.number().int().min(1).max(365).default(30),
      PHASE2_CONTACT_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
      PHASE2_MFA_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
      PHASE2_REQUEST_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
    });
    const p = schema.parse(input);
    this.enabled = p.PHASE2_ENABLED === 'true';
    this.activeKey = p.PHASE2_ACTIVE_KEY_ID;
    try {
      this.keys = z
        .record(z.string().regex(/^v\d+$/), z.string().regex(/^[a-f0-9]{64}$/i))
        .parse(JSON.parse(p.PHASE2_DATA_KEYS));
    } catch {
      throw new DomainError('DOMAIN_UNAVAILABLE', 503);
    }
    this.noticeVersion = p.PHASE2_NOTICE_VERSION;
    this.caseDays = p.PHASE2_CASE_DAYS;
    this.consentDays = p.PHASE2_CONSENT_DAYS;
    this.maxAttempts = p.PHASE2_CONTACT_ATTEMPTS;
    this.mfaSeconds = p.PHASE2_MFA_SECONDS;
    this.requestLimit = p.PHASE2_REQUEST_LIMIT;
  }
  ready() {
    if (!this.enabled || !this.keys[this.activeKey] || !this.keys.v1)
      throw new DomainError('DOMAIN_UNAVAILABLE', 503);
  }
  digest(value: string) {
    this.ready();
    return createHmac('sha256', Buffer.from(this.keys.v1!, 'hex'))
      .update('phase2-digest\0' + value)
      .digest('hex');
  }
  seal(value: unknown, context: string) {
    this.ready();
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', Buffer.from(this.keys[this.activeKey]!, 'hex'), iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      this.activeKey,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  }
  unseal(value: string, context: string): unknown {
    try {
      const [key, iv, tag, body] = value.split('.');
      if (!key || !iv || !tag || !body || !this.keys[key]) throw new Error();
      const cipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(this.keys[key]!, 'hex'),
        Buffer.from(iv, 'base64url'),
      );
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]).toString(
          'utf8',
        ),
      );
    } catch {
      throw new DomainError('PROTECTED_DATA_UNAVAILABLE', 503);
    }
  }
}
