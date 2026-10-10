import { z } from 'zod';
import { phoneSchema } from '../auth/contracts';
export const scopes = ['RECIPIENT_DETAILS', 'EMERGENCY_CONTACTS', 'ASSISTANCE_NOTES'] as const;
export const scopeSchema = z
  .array(z.enum(scopes))
  .min(1)
  .max(3)
  .refine((v) => new Set(v).size === v.length);
export const versionSchema = z.object({ version: z.number().int().min(1) }).strict();
const short = z.string().trim().min(1).max(80);
export const profileSchema = z
  .object({ version: z.number().int().min(0), displayName: short, preferredLanguage: short })
  .strict();
const point = z
  .object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  })
  .strict();
export const addressSchema = z
  .object({
    label: short,
    line1: z.string().trim().min(3).max(160),
    line2: z.string().trim().max(160).default(''),
    locality: short,
    city: short,
    state: short,
    postalCode: z.string().regex(/^[1-9]\d{5}$/),
    country: z.literal('IN').default('IN'),
    point: point.nullable().default(null),
  })
  .strict();
export const addressPatch = addressSchema
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict()
  .refine((v) => Object.keys(v).length > 1);
export const recipientSchema = z
  .object({
    displayName: short,
    relationship: z.enum(['SELF', 'PARENT', 'SPOUSE', 'RELATIVE', 'OTHER']),
    adult: z.literal(true),
    preferredLanguage: short,
    communicationNeeds: z.string().trim().max(240).default(''),
    assistanceNotes: z.string().trim().max(500).optional(),
    state: z.enum(['DRAFT', 'PENDING_CONSENT']).default('PENDING_CONSENT'),
  })
  .strict();
export const recipientPatch = recipientSchema
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict()
  .refine((v) => Object.keys(v).length > 1);
export const contactSchema = z
  .object({ displayName: short, relationship: short, phone: phoneSchema })
  .strict();
export const contactPatch = contactSchema
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict()
  .refine((v) => Object.keys(v).length > 1);
export const consentRequest = z
  .object({
    version: z.number().int().min(1),
    preferredLanguage: short,
    communicationNeeds: z.string().trim().max(240),
    contactPhone: phoneSchema,
    contactWindow: z.string().trim().min(3).max(160),
    contactPermission: z.literal(true),
    independentConsentPossible: z.boolean(),
    requestedScopes: scopeSchema,
    noticeVersion: short,
  })
  .strict();
export const withdrawalRequest = z
  .object({
    version: z.number().int().min(1),
    reasonCode: z.enum(['RECIPIENT_REQUESTED_CONTACT', 'CORRECTION_REQUIRED']),
  })
  .strict();
export const invitationSchema = z
  .object({
    version: z.number().int().min(1),
    phone: phoneSchema,
    role: z.enum(['EDITOR', 'VIEWER']),
    scopes: scopeSchema,
  })
  .strict();
export const contactAttemptSchema = z
  .object({
    version: z.number().int().min(1),
    result: z.enum(['CONNECTED', 'NO_ANSWER', 'DECLINED_CONTACT', 'UNSAFE']),
    method: z.enum(['DIRECT_PHONE', 'IN_PERSON', 'INDEPENDENT_INTERPRETER']),
    channelChecked: z.boolean(),
  })
  .strict();
const evidenceReferences = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{6,100}$/))
  .min(1)
  .max(5);
export const evidenceSchema = z
  .object({
    version: z.number().int().min(1),
    verificationMethod: z.enum(['DIRECT_PHONE', 'IN_PERSON', 'INDEPENDENT_INTERPRETER']),
    channelCheck: z.enum([
      'INDEPENDENT_DIRECTORY',
      'RECIPIENT_CONTROL_CONFIRMED',
      'IN_PERSON_CONTACT',
    ]),
    identityCheck: z.enum([
      'TWO_NON_SENSITIVE_FACTORS',
      'KNOWN_RECIPIENT_IN_PERSON',
      'NOT_ESTABLISHED',
    ]),
    independent: z.boolean(),
    understood: z.boolean(),
    conflictFree: z.boolean(),
    disclosedCategories: z.boolean(),
    disclosedPurpose: z.boolean(),
    withdrawalExplained: z.boolean(),
    comprehensionCheck: z.enum([
      'EXPLAINED_IN_OWN_WORDS',
      'AFFIRMATIVE_ACCESSIBLE_RESPONSE',
      'NOT_ESTABLISHED',
    ]),
    outcome: z.enum(['AFFIRMATIVE', 'DECLINED', 'UNVERIFIABLE', 'LAWFUL_AUTHORITY']),
    scopes: z.array(z.enum(scopes)).max(3),
    noticeVersion: short,
    evidenceReferences,
  })
  .strict();
export const decisionSchema = z
  .object({
    version: z.number().int().min(1),
    outcome: z.enum([
      'APPROVE',
      'DECLINE',
      'UNVERIFIED',
      'NEEDS_MORE_EVIDENCE',
      'LAWFUL_AUTHORITY_REVIEW_REQUIRED',
    ]),
    reasonCode: z.enum([
      'SUFFICIENT_INDEPENDENT_EVIDENCE',
      'RECIPIENT_DECLINED',
      'INSUFFICIENT_EVIDENCE',
      'IDENTITY_UNVERIFIED',
      'LAWFUL_AUTHORITY_REQUIRED',
    ]),
  })
  .strict();
export const staffWithdrawal = z
  .object({
    version: z.number().int().min(1),
    independent: z.literal(true),
    channelChecked: z.literal(true),
    identityCheck: z.enum(['TWO_NON_SENSITIVE_FACTORS', 'KNOWN_RECIPIENT_IN_PERSON']),
    evidenceReferences,
  })
  .strict();
export const listSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(250).optional(),
    state: z.string().max(50).optional(),
  })
  .strict();
export const acceptanceSchema = z.object({}).strict();
export type Scope = (typeof scopes)[number];
