import { z } from 'zod';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { scopes } from './contracts';
const id = z.uuid(),
  version = z.number().int(),
  date = z.string().datetime(),
  scope = z.array(z.enum(scopes));
const policy = z.object({
  noticeVersion: z.string(),
  development: z.literal(true),
  scopes: scope,
  caseDays: z.number(),
  consentDays: z.number(),
  notice: z.string(),
});
const profile = z.object({
  id: id.nullable(),
  version,
  displayName: z.string(),
  preferredLanguage: z.string(),
  maskedPhone: z.string(),
  policy,
});
const address = z.object({
  id,
  version,
  label: z.string(),
  line1: z.string(),
  line2: z.string(),
  locality: z.string(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.literal('IN'),
  point: z
    .object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]) })
    .nullable(),
});
const recipient = z.object({
  id,
  version,
  displayName: z.string(),
  relationship: z.string(),
  adult: z.literal(true),
  preferredLanguage: z.string(),
  communicationNeeds: z.string(),
  state: z.string(),
  sharingFrozen: z.boolean(),
  consentScopes: scope,
  consentExpiresAt: date.nullable(),
  role: z.enum(['STEWARD', 'EDITOR', 'VIEWER']),
  assistanceNotes: z.string().optional(),
});
const contact = z.object({
  id,
  version,
  displayName: z.string(),
  relationship: z.string(),
  maskedPhone: z.string(),
});
const member = z.object({
  id,
  version,
  role: z.string(),
  scopes: scope,
  status: z.string(),
  identityLabel: z.string(),
});
const invitation = z.object({
  id,
  version,
  role: z.string(),
  scopes: scope,
  maskedPhone: z.string(),
  status: z.string(),
  expiresAt: date,
});
const minimalCase = z.object({
  id,
  version,
  recipientId: id,
  state: z.string(),
  kind: z.string(),
  assignedReviewerId: id.nullable(),
  secondApproverId: id.nullable(),
  requestedScopes: scope,
  consentScopes: scope,
  noticeVersion: z.string(),
  contactAttempts: z.number(),
  expiresAt: date,
  reasonCode: z.string().nullable(),
});
const evidence = z.object({
  verificationMethod: z.string(),
  channelCheck: z.string(),
  identityCheck: z.string(),
  independent: z.boolean(),
  understood: z.boolean(),
  conflictFree: z.boolean(),
  disclosedCategories: z.boolean(),
  disclosedPurpose: z.boolean(),
  withdrawalExplained: z.boolean(),
  comprehensionCheck: z.string(),
  outcome: z.string(),
  scopes: scope,
  noticeVersion: z.string(),
  evidenceReferences: z.array(z.string()),
});
const detail = minimalCase.extend({
  recipientIdentity: z.object({ displayName: z.string(), adult: z.literal(true) }).nullable(),
  canClaim: z.boolean(),
  canReview: z.boolean(),
  canDecide: z.boolean(),
  contact: z
    .object({
      phone: z.string(),
      window: z.string(),
      language: z.string(),
      communicationNeeds: z.string(),
    })
    .nullable(),
  evidence: evidence.nullable(),
  policy: z.object({
    maxAttempts: z.number(),
    noticeVersion: z.string(),
    caseDays: z.number(),
    consentDays: z.number(),
  }),
  timeline: z.array(z.object({ id, action: z.string(), actorId: id, createdAt: date })),
});
const consent = z.object({
  recipientId: id,
  version,
  state: z.string(),
  sharingFrozen: z.boolean(),
  scopes: scope,
  expiresAt: date.nullable(),
  noticeVersion: z.string(),
  case: z
    .object({
      id,
      version,
      state: z.string(),
      kind: z.string(),
      expiresAt: date,
      reasonCode: z.string().nullable(),
    })
    .nullable(),
  nextStep: z.string(),
});
const request = z.object({
  id,
  version,
  state: z.string(),
  recipientVersion: version,
  sharingFrozen: z.boolean().optional(),
});
const page = (item: z.ZodType) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export function familyResponse(path: string, method: string): SchemaObject | undefined {
  let schema: z.ZodType | undefined;
  if (path === '/v1/customer/profile') schema = profile;
  else if (path === '/v1/customer/consent-policy') schema = policy;
  else if (path.includes('/admin/support/'))
    schema = page(
      z.object({
        id,
        version,
        nameLabel: z.string(),
        state: z.string(),
        sharingFrozen: z.boolean(),
        consentExpiresAt: date.nullable(),
      }),
    );
  else if (path === '/v1/admin/consent-cases') schema = page(minimalCase);
  else if (path.startsWith('/v1/admin/consent-cases/'))
    schema = method === 'get' ? detail : minimalCase;
  else if (path.endsWith('/privacy/activity'))
    schema = page(z.object({ id, action: z.string(), resourceId: z.string(), createdAt: date }));
  else if (path.includes('/care-circle/invitations/') && path.endsWith('/accept'))
    schema = z.object({ recipientId: id, role: z.string(), scopes: scope });
  else if (path.includes('/care-circle/')) {
    if (method === 'delete') schema = z.object({ id, status: z.literal('REVOKED'), version });
    else if (path.endsWith('/invitations'))
      schema =
        method === 'get'
          ? page(invitation)
          : z.object({
              id,
              version,
              token: z.string(),
              status: z.literal('PENDING'),
              message: z.string(),
              recipientVersion: version,
            });
  } else if (path.endsWith('/care-circle')) schema = page(member);
  else if (/\/(consent|assisted-consent-status)$/.test(path)) schema = consent;
  else if (/\/(assisted-consent-requests|consent-requests|consent-withdrawal-requests)$/.test(path))
    schema = request;
  else if (path.includes('/emergency-contacts'))
    schema = path.endsWith('/emergency-contacts') && method === 'get' ? page(contact) : contact;
  else if (path.startsWith('/v1/customer/addresses'))
    schema = path.endsWith('/addresses') && method === 'get' ? page(address) : address;
  else if (path.startsWith('/v1/customer/recipients') && !path.endsWith('/consent-withdrawal'))
    schema =
      path.endsWith('/recipients') && method === 'get'
        ? page(recipient.omit({ assistanceNotes: true }))
        : recipient;
  return schema ? (z.toJSONSchema(schema, { target: 'openapi-3.0' }) as SchemaObject) : undefined;
}
