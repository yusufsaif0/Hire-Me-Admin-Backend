async function migrate(client, dbName) {
  const db = client.db(dbName);
  if (!(await db.collection('schema_migrations').findOne({ version: '0001' })))
    throw new Error('Identity migration 0001 must be applied first');
  const indexes = {
    customer_profiles: [[{ ownerId: 1 }, { unique: true, name: 'profile_owner' }]],
    customer_addresses: [[{ ownerId: 1, createdAt: 1, _id: 1 }, { name: 'address_owner_page' }]],
    care_recipients: [
      [{ stewardId: 1, createdAt: 1, _id: 1 }, { name: 'recipient_owner_page' }],
      [{ 'sharedWith.identityId': 1, state: 1 }, { name: 'recipient_sharing' }],
    ],
    recipient_consents: [[{ recipientId: 1, createdAt: 1 }, { name: 'recipient_consent_history' }]],
    emergency_contacts: [[{ recipientId: 1, createdAt: 1, _id: 1 }, { name: 'contact_recipient' }]],
    care_circle_memberships: [
      [
        { recipientId: 1, identityId: 1 },
        { unique: true, name: 'circle_identity' },
      ],
    ],
    care_circle_invitations: [
      [{ tokenDigest: 1 }, { unique: true, name: 'invitation_digest' }],
      [{ recipientId: 1, createdAt: 1, _id: 1 }, { name: 'invitation_recipient' }],
    ],
    care_circle_invitation_artifacts: [
      [{ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'transient_token_expiry' }],
    ],
    privacy_audit_events: [[{ actorId: 1, createdAt: 1, _id: 1 }, { name: 'privacy_actor_page' }]],
    assisted_consent_cases: [
      [
        { recipientId: 1 },
        { unique: true, partialFilterExpression: { open: true }, name: 'one_open_case' },
      ],
      [{ state: 1, createdAt: 1, _id: 1 }, { name: 'consent_queue' }],
      [{ stewardId: 1, recipientId: 1, createdAt: 1 }, { name: 'consent_steward' }],
    ],
    consent_contact_attempts: [[{ caseId: 1, createdAt: 1 }, { name: 'contact_case' }]],
    consent_review_events: [[{ caseId: 1, createdAt: 1, _id: 1 }, { name: 'case_timeline' }]],
    consent_staff_permissions: [[{ identityId: 1 }, { unique: true, name: 'staff_identity' }]],
    phase2_operations: [
      [
        { actorId: 1, operation: 1, key: 1 },
        { unique: true, name: 'operation_idempotency' },
      ],
    ],
    phase2_rate_limits: [
      [
        { actorId: 1, kind: 1, bucket: 1 },
        { unique: true, name: 'domain_limit' },
      ],
    ],
  };
  for (const [name, specs] of Object.entries(indexes))
    for (const [keys, options] of specs) await db.collection(name).createIndex(keys, options);
  await db
    .collection('schema_migrations')
    .updateOne(
      { version: '0002' },
      { $setOnInsert: { version: '0002', appliedAt: new Date(), owner: 'admin-panel/backend' } },
      { upsert: true },
    );
}
module.exports = { migrate };
