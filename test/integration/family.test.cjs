require('reflect-metadata');
const { test, before, after, beforeEach } = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto');
const { MongoClient } = require('mongodb'),
  { Test } = require('@nestjs/testing'),
  request = require('supertest');
const { migrate: identityMigration } = require('../fixtures/identity-schema.cjs'),
  { migrate } = require('../fixtures/family-schema.cjs');
const { AuthSettings } = require('../../dist/auth/settings'),
  { AuthRepository } = require('../../dist/auth/repository'),
  { AuthService } = require('../../dist/auth/service'),
  { MockSms } = require('../../dist/auth/mock-sms'),
  { totp } = require('../../dist/auth/crypto');
const { FamilySettings } = require('../../dist/family/settings'),
  { CustomerFamilyService } = require('../../dist/family/customer-service'),
  { ConsentAdminService } = require('../../dist/family/admin-service'),
  C = require('../../dist/family/contracts');
const { AppModule } = require('../../dist/app.module'),
  { backendRole, parseBackendEnvironment } = require('../../dist/environment'),
  { configureHttp } = require('../../dist/http');
const uri =
  process.env.TEST_MONGODB_URL ?? 'mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true';
const dbName =
    'hire_me_test_phase2_' + backendRole.toLowerCase() + '_' + randomUUID().replaceAll('-', ''),
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
const key = () => randomUUID(),
  meta = { ip: 'phase2-test', device: 'test-fixture' },
  password = 'Phase2 isolated fixture password only!';
const auth = {},
  repos = {},
  settings = {},
  tokens = {},
  actors = {};
let app,
  db,
  customer,
  admin,
  policy,
  clock = Date.now(),
  phoneIndex = 100000;
const phone = () => '+919997' + phoneIndex++;
function config() {
  const rsa = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    NODE_ENV: 'test',
    AUTH_ENABLED: 'true',
    MONGODB_URL: uri,
    MONGODB_DB_NAME: dbName,
    AUTH_DIGEST_KEY: randomBytes(32).toString('hex'),
    AUTH_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    AUTH_PRIVATE_KEY: Buffer.from(rsa.privateKey).toString('base64'),
    AUTH_PUBLIC_KEY: Buffer.from(rsa.publicKey).toString('base64'),
    AUTH_IP_LIMIT: '1000',
    AUTH_PHONE_LIMIT: '1000',
    AUTH_ADMIN_LOGIN_LIMIT: '1000',
    CORS_ORIGIN: 'http://localhost:3000',
  };
}
async function customerLogin(label) {
  const number = phone(),
    challenge = await auth.CUSTOMER.requestOtp(number, 'CUSTOMER_LOGIN', meta);
  tokens[label] = await auth.CUSTOMER.verifyOtp(
    challenge.challengeId,
    challenge.challengeToken,
    auth.CUSTOMER.sms.capturedCode(challenge.challengeId),
    meta,
  );
  actors[label] = await auth.CUSTOMER.authenticate(tokens[label].accessToken);
  return number;
}
async function adminLogin(label, capabilities = []) {
  const number = phone(),
    setupSettings = new AuthSettings('ADMIN', {
      ...settings.ADMIN.env,
      ...settings.ADMIN.values,
      NODE_ENV: 'development',
    }),
    setupRepo = new AuthRepository(setupSettings);
  let seed;
  try {
    seed = await new AuthService(
      setupSettings,
      setupRepo,
      new MockSms(setupSettings),
    ).provisionAdmin(number, password);
  } finally {
    await setupRepo.onModuleDestroy();
  }
  const challenge = await auth.ADMIN.adminLogin(number, password, meta);
  tokens[label] = await auth.ADMIN.verifyMfa(
    challenge.mfaChallengeId,
    challenge.mfaToken,
    totp(seed, Math.floor(clock / 30000)),
    meta,
  );
  actors[label] = await auth.ADMIN.authenticate(tokens[label].accessToken);
  if (capabilities.length)
    await db.collection('consent_staff_permissions').insertOne({
      _id: key(),
      identityId: actors[label].user.id,
      capabilities,
      status: 'ACTIVE',
      createdAt: new Date(clock),
      updatedAt: new Date(clock),
      version: 1,
    });
}
let bPhone, cPhone;
before(async () => {
  if (!uri.startsWith('mongodb://') || !['localhost', '127.0.0.1'].includes(new URL(uri).hostname))
    throw new Error('Only isolated local MongoDB is allowed');
  await client.connect();
  db = client.db(dbName);
  await identityMigration(client, dbName);
  await migrate(client, dbName);
  for (const role of ['CUSTOMER', 'ADMIN', 'WORKER']) {
    settings[role] = new AuthSettings(role, config());
    repos[role] = new AuthRepository(settings[role]);
    auth[role] = new AuthService(
      settings[role],
      repos[role],
      new MockSms(settings[role], true),
      () => clock,
    );
  }
  policy = new FamilySettings({
    PHASE2_ENABLED: 'true',
    PHASE2_DATA_KEYS: JSON.stringify({ v1: randomBytes(32).toString('hex') }),
    PHASE2_REQUEST_LIMIT: '100',
  });
  customer = new CustomerFamilyService(settings.CUSTOMER, repos.CUSTOMER, policy, () => clock);
  admin = new ConsentAdminService(settings.ADMIN, repos.ADMIN, policy, () => clock);
  await customerLogin('a');
  bPhone = await customerLogin('b');
  cPhone = await customerLogin('c');
  await adminLogin('reviewer', ['CONSENT_REVIEWER', 'CONSENT_APPROVER', 'SUPPORT_VIEWER']);
  await adminLogin('approver', ['CONSENT_REVIEWER', 'CONSENT_APPROVER', 'SUPPORT_VIEWER']);
  await adminLogin('ordinary');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AuthSettings)
    .useValue(settings[backendRole])
    .overrideProvider(AuthRepository)
    .useValue(repos[backendRole])
    .overrideProvider(AuthService)
    .useValue(auth[backendRole])
    .overrideProvider(MockSms)
    .useValue(auth[backendRole].sms)
    .overrideProvider(FamilySettings)
    .useValue(policy)
    .overrideProvider(CustomerFamilyService)
    .useValue(customer)
    .overrideProvider(ConsentAdminService)
    .useValue(admin)
    .compile();
  app = module.createNestApplication();
  configureHttp(
    app,
    parseBackendEnvironment({ NODE_ENV: 'test', CORS_ORIGIN: 'http://localhost:3000' }),
  );
  await app.init();
});
beforeEach(() => {
  clock = Date.now();
});
after(async () => {
  await app?.close();
  for (const repo of Object.values(repos)) await repo.onModuleDestroy();
  if (!/^hire_me_test_phase2_(customer|admin)_[a-f0-9]{32}$/.test(dbName))
    throw new Error('Unsafe cleanup');
  await db?.dropDatabase();
  await client.close();
});
const rejects = (fn, code) => assert.rejects(fn, (error) => error.code === code);
async function recipient(notes = 'Short assistance preferences only') {
  return customer.writeRecipient(
    actors.a,
    key(),
    null,
    C.recipientSchema.parse({
      displayName: 'Adult family member',
      relationship: 'PARENT',
      adult: true,
      preferredLanguage: 'Hindi',
      assistanceNotes: notes,
    }),
  );
}
async function requestCase(r, changes = {}) {
  return customer.requestConsent(
    actors.a,
    key(),
    r.id,
    C.consentRequest.parse({
      version: r.version,
      preferredLanguage: 'Hindi',
      communicationNeeds: 'Speak clearly',
      contactPhone: '+919996123456',
      contactWindow: 'Afternoon',
      contactPermission: true,
      independentConsentPossible: true,
      requestedScopes: [...C.scopes],
      noticeVersion: policy.noticeVersion,
      ...changes,
    }),
  );
}
const evidence = (version, changes = {}) =>
  C.evidenceSchema.parse({
    version,
    verificationMethod: 'DIRECT_PHONE',
    channelCheck: 'RECIPIENT_CONTROL_CONFIRMED',
    identityCheck: 'TWO_NON_SENSITIVE_FACTORS',
    independent: true,
    understood: true,
    conflictFree: true,
    disclosedCategories: true,
    disclosedPurpose: true,
    withdrawalExplained: true,
    comprehensionCheck: 'EXPLAINED_IN_OWN_WORDS',
    outcome: 'AFFIRMATIVE',
    scopes: [...C.scopes],
    noticeVersion: policy.noticeVersion,
    evidenceReferences: ['TEST_ONLY_REFERENCE'],
    ...changes,
  });
async function submitted(changes = {}, requestChanges = {}) {
  const r = await recipient(),
    c = await requestCase(r, requestChanges);
  assert.equal((await admin.detail(actors.reviewer, c.id)).recipientIdentity, null);
  let row = await admin.claim(actors.reviewer, key(), c.id, { version: c.version });
  assert.equal(
    (await admin.detail(actors.reviewer, c.id)).recipientIdentity.displayName,
    'Adult family member',
  );
  row = await admin.contactAttempt(actors.reviewer, key(), c.id, {
    version: row.version,
    result: 'CONNECTED',
    method: 'DIRECT_PHONE',
    channelChecked: true,
  });
  row = await admin.evidence(actors.reviewer, key(), c.id, evidence(row.version, changes));
  row = await admin.submit(actors.reviewer, key(), c.id, { version: row.version });
  return { r: await customer.recipientDetail(actors.a, r.id), c: row };
}
async function active() {
  const { r, c } = await submitted();
  await admin.decision(actors.approver, key(), c.id, {
    version: c.version,
    outcome: 'APPROVE',
    reasonCode: 'SUFFICIENT_INDEPENDENT_EVIDENCE',
  });
  return customer.recipientDetail(actors.a, r.id);
}
async function invite(r, role = 'EDITOR', scopes = [...C.scopes], number = bPhone) {
  return customer.invite(actors.a, key(), r.id, {
    version: r.version,
    phone: number,
    role,
    scopes,
  });
}

test('migration 0002 is idempotent, preserves auth indexes and gives evidence no TTL', async () => {
  const old = await db.collection('identities').indexes();
  await migrate(client, dbName);
  await migrate(client, dbName);
  assert.deepEqual(await db.collection('identities').indexes(), old);
  assert.equal(await db.collection('schema_migrations').countDocuments({ version: '0002' }), 1);
  for (const name of [
    'recipient_consents',
    'consent_review_events',
    'privacy_audit_events',
    'assisted_consent_cases',
  ])
    assert.equal(
      (await db.collection(name).indexes()).some((v) => v.expireAfterSeconds !== undefined),
      false,
    );
  assert.equal(
    (await db.collection('care_circle_invitation_artifacts').indexes()).find(
      (v) => v.name === 'transient_token_expiry',
    ).expireAfterSeconds,
    0,
  );
});
test('profile persistence, duplicate retry and optimistic concurrency preserve verified phone', async () => {
  const initial = await customer.profile(actors.a),
    body = { version: initial.version, displayName: 'Test customer', preferredLanguage: 'English' },
    operation = key(),
    saved = await customer.saveProfile(actors.a, operation, body);
  assert.deepEqual(await customer.saveProfile(actors.a, operation, body), saved);
  assert.equal((await customer.profile(actors.b)).version, 0);
  assert.equal(saved.maskedPhone, actors.a.user.maskedPhone);
  await rejects(
    () => customer.saveProfile(actors.a, operation, { ...body, displayName: 'Changed' }),
    'IDEMPOTENCY_CONFLICT',
  );
  const results = await Promise.allSettled(
    ['First', 'Second'].map((displayName) =>
      customer.saveProfile(actors.a, key(), {
        version: saved.version,
        displayName,
        preferredLanguage: 'English',
      }),
    ),
  );
  assert.equal(results.filter((v) => v.status === 'fulfilled').length, 1);
  assert.equal(results.find((v) => v.status === 'rejected').reason.code, 'VERSION_CONFLICT');
});
test('addresses enforce owner isolation, validated GeoJSON and soft archive', async () => {
  const body = C.addressSchema.parse({
    label: 'Home',
    line1: 'Test street 10',
    locality: 'Locality',
    city: 'Delhi',
    state: 'Delhi',
    postalCode: '110001',
    point: { type: 'Point', coordinates: [77.2, 28.6] },
  });
  const a = await customer.writeAddress(actors.a, key(), null, body);
  await rejects(() => customer.address(actors.b, a.id), 'NOT_FOUND');
  assert.equal((await customer.addresses(actors.b, {})).items.length, 0);
  assert.equal(
    C.addressSchema.safeParse({ ...body, point: { type: 'Point', coordinates: [28, 190] } })
      .success,
    false,
  );
  await customer.writeAddress(actors.a, key(), a.id, { version: a.version }, true);
  await rejects(() => customer.address(actors.a, a.id), 'NOT_FOUND');
  assert.ok((await db.collection('customer_addresses').findOne({ _id: a.id })).archivedAt);
});
test('recipients start pending, owner-only data persists and list excludes notes', async () => {
  const r = await recipient('Encrypted private preferences');
  assert.equal(r.state, 'PENDING_CONSENT');
  assert.equal(r.assistanceNotes, 'Encrypted private preferences');
  await rejects(() => customer.recipientDetail(actors.b, r.id), 'NOT_FOUND');
  const stored = await db.collection('care_recipients').findOne({ _id: r.id });
  assert.equal(JSON.stringify(stored).includes('Encrypted private preferences'), false);
  const list = await customer.recipients(actors.a, {});
  const listed = list.items.find((v) => v.id === r.id);
  assert.equal('assistanceNotes' in listed, false);
  assert.equal('notesSealed' in listed, false);
  await rejects(
    () =>
      customer.invite(actors.a, key(), r.id, {
        version: r.version,
        phone: bPhone,
        role: 'VIEWER',
        scopes: ['RECIPIENT_DETAILS'],
      }),
    'CONSENT_REQUIRED',
  );
});
test('note encryption rejects key/AAD tampering and supports retained versioned keys', async () => {
  assert.throws(
    () => new FamilySettings({ PHASE2_DATA_KEYS: 'malformed-private-key-config' }),
    (error) => error.code === 'DOMAIN_UNAVAILABLE' && !error.message.includes('private-key'),
  );

  const ring = { v1: randomBytes(32).toString('hex'), v2: randomBytes(32).toString('hex') },
    old = new FamilySettings({ PHASE2_ENABLED: 'true', PHASE2_DATA_KEYS: JSON.stringify(ring) }),
    next = new FamilySettings({
      PHASE2_ENABLED: 'true',
      PHASE2_DATA_KEYS: JSON.stringify(ring),
      PHASE2_ACTIVE_KEY_ID: 'v2',
    }),
    value = old.seal('Private', 'recipient:fixture:notes');
  assert.equal(next.unseal(value, 'recipient:fixture:notes'), 'Private');
  assert.equal(next.seal('New', 'recipient:fixture:notes').split('.')[0], 'v2');
  assert.throws(() => next.unseal(value, 'recipient:other:notes'));
  assert.throws(() => next.unseal(value.slice(0, -4) + 'AAAA', 'recipient:fixture:notes'));
});
test('emergency contacts remain records, edits conflict and phones are encrypted/masked', async () => {
  const r = await recipient(),
    before = await db.collection('role_memberships').countDocuments({}),
    c = await customer.writeContact(actors.a, key(), r.id, null, {
      displayName: 'Contact',
      relationship: 'Sibling',
      phone: '+919995111222',
    });
  assert.equal(
    (await customer.contacts(actors.a, r.id, {})).items[0].maskedPhone.includes('111222'),
    false,
  );
  assert.equal(await db.collection('role_memberships').countDocuments({}), before);
  assert.equal(
    JSON.stringify(await db.collection('emergency_contacts').findOne({ _id: c.id })).includes(
      '+919995111222',
    ),
    false,
  );
  await rejects(
    () =>
      customer.writeContact(actors.b, key(), r.id, c.id, {
        version: c.version,
        displayName: 'Intruder',
      }),
    'NOT_FOUND',
  );
  await customer.writeContact(actors.a, key(), r.id, c.id, {
    version: c.version,
    displayName: 'Updated',
  });
  await rejects(
    () =>
      customer.writeContact(actors.a, key(), r.id, c.id, {
        version: c.version,
        displayName: 'Stale',
      }),
    'VERSION_CONFLICT',
  );
});
test('consent requests are idempotent and concurrent duplicates create one open case', async () => {
  const r = await recipient(),
    body = C.consentRequest.parse({
      version: r.version,
      preferredLanguage: 'English',
      communicationNeeds: '',
      contactPhone: '+919992111222',
      contactWindow: 'Morning',
      contactPermission: true,
      independentConsentPossible: true,
      requestedScopes: ['RECIPIENT_DETAILS'],
      noticeVersion: policy.noticeVersion,
    }),
    operation = key();
  const row = await customer.requestConsent(actors.a, operation, r.id, body);
  assert.deepEqual(await customer.requestConsent(actors.a, operation, r.id, body), row);
  await rejects(
    async () => requestCase(await customer.recipientDetail(actors.a, r.id)),
    'OPEN_CASE_EXISTS',
  );
  assert.equal(
    await db.collection('assisted_consent_cases').countDocuments({ recipientId: r.id, open: true }),
    1,
  );
});
test('ordinary admins have no implicit consent access and recent MFA is required', async () => {
  await rejects(() => admin.queue(actors.ordinary, {}), 'CONSENT_PERMISSION_REQUIRED');
  const { c } = await submitted();
  clock += 601000;
  await rejects(
    () =>
      admin.decision(actors.approver, key(), c.id, {
        version: c.version,
        outcome: 'APPROVE',
        reasonCode: 'SUFFICIENT_INDEPENDENT_EVIDENCE',
      }),
    'RECENT_MFA_REQUIRED',
  );
});
test('concurrent reviewer claims assign one person and staff detail is audited/redacted', async () => {
  const r = await recipient(),
    c = await requestCase(r),
    results = await Promise.allSettled(
      [actors.reviewer, actors.approver].map((a) =>
        admin.claim(a, key(), c.id, { version: c.version }),
      ),
    );
  assert.equal(results.filter((v) => v.status === 'fulfilled').length, 1);
  const stored = await db.collection('assisted_consent_cases').findOne({ _id: c.id }),
    a = stored.assignedReviewerId === actors.reviewer.user.id ? actors.reviewer : actors.approver;
  const detail = await admin.detail(a, c.id);
  assert.equal(detail.contact.phone, '+919996123456');
  assert.equal('assistanceNotes' in detail, false);
  assert.equal(
    (await admin.queue(a, {})).items.some((v) => 'contact' in v),
    false,
  );
  assert.ok(
    await db
      .collection('consent_review_events')
      .findOne({ caseId: c.id, action: 'CONSENT_CASE_VIEWED' }),
  );
});
test('same-person approval is forbidden and sufficient two-person evidence activates scoped consent', async () => {
  const { r, c } = await submitted();
  await rejects(
    () =>
      admin.decision(actors.reviewer, key(), c.id, {
        version: c.version,
        outcome: 'APPROVE',
        reasonCode: 'SUFFICIENT_INDEPENDENT_EVIDENCE',
      }),
    'TWO_PERSON_RULE',
  );
  const operation = key(),
    body = {
      version: c.version,
      outcome: 'APPROVE',
      reasonCode: 'SUFFICIENT_INDEPENDENT_EVIDENCE',
    },
    approved = await admin.decision(actors.approver, operation, c.id, body);
  assert.equal(approved.state, 'APPROVED');
  assert.equal((await customer.recipientDetail(actors.a, r.id)).state, 'ACTIVE');
  assert.deepEqual(await admin.decision(actors.approver, operation, c.id, body), approved);
  assert.equal(await db.collection('recipient_consents').countDocuments({ recipientId: r.id }), 1);
  await rejects(() => admin.decision(actors.approver, key(), c.id, body), 'CASE_EXPIRED_OR_CLOSED');
});
test('forged family, pressured/unclear response and mistaken identity cannot activate consent', async () => {
  for (const changes of [
    { independent: false },
    { understood: false, comprehensionCheck: 'NOT_ESTABLISHED' },
    { identityCheck: 'NOT_ESTABLISHED' },
    { conflictFree: false },
    { outcome: 'UNVERIFIABLE' },
  ]) {
    const { r, c } = await submitted(changes);
    await rejects(
      () =>
        admin.decision(actors.approver, key(), c.id, {
          version: c.version,
          outcome: 'APPROVE',
          reasonCode: 'SUFFICIENT_INDEPENDENT_EVIDENCE',
        }),
      'INSUFFICIENT_INDEPENDENT_EVIDENCE',
    );
    assert.equal((await customer.recipientDetail(actors.a, r.id)).sharingFrozen, true);
  }
  assert.equal(
    C.evidenceSchema.safeParse(evidence(1, { verificationMethod: 'DIRECT_PHONE' })).success,
    true,
  );
  assert.equal(
    C.evidenceSchema.safeParse({ ...evidence(1), verificationMethod: 'FAMILY_ASSERTION' }).success,
    false,
  );
});
test('no-answer evidence is reviewable but cannot approve; bounded contact attempts persist', async () => {
  const r = await recipient(),
    c = await requestCase(r);
  let row = await admin.claim(actors.reviewer, key(), c.id, { version: 1 });
  for (let i = 0; i < policy.maxAttempts; i++)
    row = await admin.contactAttempt(actors.reviewer, key(), c.id, {
      version: row.version,
      result: 'NO_ANSWER',
      method: 'DIRECT_PHONE',
      channelChecked: false,
    });
  await rejects(
    () =>
      admin.contactAttempt(actors.reviewer, key(), c.id, {
        version: row.version,
        result: 'NO_ANSWER',
        method: 'DIRECT_PHONE',
        channelChecked: false,
      }),
    'CONTACT_LIMIT',
  );
  row = await admin.evidence(
    actors.reviewer,
    key(),
    c.id,
    evidence(row.version, {
      outcome: 'UNVERIFIABLE',
      independent: false,
      understood: false,
      identityCheck: 'NOT_ESTABLISHED',
      comprehensionCheck: 'NOT_ESTABLISHED',
      scopes: [],
    }),
  );
  row = await admin.submit(actors.reviewer, key(), c.id, { version: row.version });
  await rejects(
    () =>
      admin.decision(actors.approver, key(), c.id, {
        version: row.version,
        outcome: 'APPROVE',
        reasonCode: 'SUFFICIENT_INDEPENDENT_EVIDENCE',
      }),
    'INSUFFICIENT_INDEPENDENT_EVIDENCE',
  );
  const result = await admin.decision(actors.approver, key(), c.id, {
    version: row.version,
    outcome: 'UNVERIFIED',
    reasonCode: 'IDENTITY_UNVERIFIED',
  });
  assert.equal(result.state, 'UNVERIFIED');
});
test('absence of evidence, expired case and inability to consent fail closed', async () => {
  const r = await recipient(),
    c = await requestCase(r),
    claimed = await admin.claim(actors.reviewer, key(), c.id, { version: 1 });
  await rejects(
    () => admin.submit(actors.reviewer, key(), c.id, { version: claimed.version }),
    'INVALID_TRANSITION',
  );
  await db
    .collection('assisted_consent_cases')
    .updateOne({ _id: c.id }, { $set: { expiresAt: new Date(clock - 1) } });
  await rejects(
    () =>
      admin.contactAttempt(actors.reviewer, key(), c.id, {
        version: claimed.version,
        result: 'CONNECTED',
        method: 'DIRECT_PHONE',
        channelChecked: true,
      }),
    'CASE_EXPIRED_OR_CLOSED',
  );
  const renewal = await requestCase(await customer.recipientDetail(actors.a, r.id));
  assert.equal(renewal.state, 'REQUESTED');
  const denied = await submitted({}, { independentConsentPossible: false });
  await rejects(
    () =>
      admin.decision(actors.approver, key(), denied.c.id, {
        version: denied.c.version,
        outcome: 'APPROVE',
        reasonCode: 'SUFFICIENT_INDEPENDENT_EVIDENCE',
      }),
    'INSUFFICIENT_INDEPENDENT_EVIDENCE',
  );
  const result = await admin.decision(actors.approver, key(), denied.c.id, {
    version: denied.c.version,
    outcome: 'LAWFUL_AUTHORITY_REVIEW_REQUIRED',
    reasonCode: 'LAWFUL_AUTHORITY_REQUIRED',
  });
  assert.equal(result.state, 'LAWFUL_AUTHORITY_REVIEW_REQUIRED');
});
test('declined consent stays blocked and may start a new independent review', async () => {
  const { r, c } = await submitted({ outcome: 'DECLINED', scopes: [] });
  await admin.decision(actors.approver, key(), c.id, {
    version: c.version,
    outcome: 'DECLINE',
    reasonCode: 'RECIPIENT_DECLINED',
  });
  const pending = await customer.recipientDetail(actors.a, r.id);
  assert.equal(pending.state, 'PENDING_CONSENT');
  assert.equal(pending.sharingFrozen, true);
  assert.equal((await requestCase(pending)).state, 'REQUESTED');
});
test('invitation binds verified intended identity, is single use and never reveals account existence', async () => {
  const r = await active(),
    v = await invite(r);
  await rejects(() => customer.accept(actors.c, key(), v.token), 'INVITATION_UNAVAILABLE');
  await customer.accept(actors.b, key(), v.token);
  await rejects(() => customer.accept(actors.b, key(), v.token), 'INVITATION_USED_OR_REVOKED');
  const unknown = await invite(
      await customer.recipientDetail(actors.a, r.id),
      'VIEWER',
      ['RECIPIENT_DETAILS'],
      '+919991123456',
    ),
    known = await invite(
      await customer.recipientDetail(actors.a, r.id),
      'VIEWER',
      ['RECIPIENT_DETAILS'],
      cPhone,
    );
  assert.deepEqual(Object.keys(unknown).sort(), Object.keys(known).sort());
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.message, known.message);
  await rejects(() => customer.accept(actors.c, key(), unknown.token), 'INVITATION_UNAVAILABLE');
  assert.equal(
    (await db.collection('care_circle_invitations').findOne({ _id: v.id })).token,
    undefined,
  );
});
test('viewer cannot edit or read notes; editor needs field scope and steward alone manages grants', async () => {
  let r = await active(),
    v = await invite(r, 'VIEWER', ['RECIPIENT_DETAILS', 'EMERGENCY_CONTACTS']);
  await customer.accept(actors.b, key(), v.token);
  let shared = await customer.recipientDetail(actors.b, r.id);
  assert.equal('assistanceNotes' in shared, false);
  await rejects(
    () =>
      customer.writeRecipient(actors.b, key(), r.id, {
        version: shared.version,
        displayName: 'Changed',
      }),
    'FORBIDDEN',
  );
  await rejects(
    () =>
      customer.invite(actors.b, key(), r.id, {
        version: shared.version,
        phone: cPhone,
        role: 'VIEWER',
        scopes: ['RECIPIENT_DETAILS'],
      }),
    'FORBIDDEN',
  );
  r = await active();
  v = await invite(r, 'EDITOR', ['RECIPIENT_DETAILS']);
  await customer.accept(actors.b, key(), v.token);
  shared = await customer.recipientDetail(actors.b, r.id);
  await rejects(
    () =>
      customer.writeRecipient(actors.b, key(), r.id, {
        version: shared.version,
        assistanceNotes: 'Not permitted',
      }),
    'FIELD_SCOPE_REQUIRED',
  );
  await rejects(() => customer.contacts(actors.b, r.id, {}), 'NOT_FOUND');
  assert.equal(
    (
      await customer.writeRecipient(actors.b, key(), r.id, {
        version: shared.version,
        displayName: 'Edited name',
      })
    ).displayName,
    'Edited name',
  );
});
test('invitation expiry, revocation, consent expiry and member revocation block access', async () => {
  let r = await active(),
    v = await invite(r);
  await db
    .collection('care_circle_invitations')
    .updateOne({ _id: v.id }, { $set: { expiresAt: new Date(clock - 1) } });
  await rejects(() => customer.accept(actors.b, key(), v.token), 'INVITATION_EXPIRED');
  v = await invite(await customer.recipientDetail(actors.a, r.id));
  await customer.revoke(actors.a, key(), r.id, v.id, { version: v.version }, true);
  await rejects(() => customer.accept(actors.b, key(), v.token), 'INVITATION_USED_OR_REVOKED');
  v = await invite(await customer.recipientDetail(actors.a, r.id));
  await customer.accept(actors.b, key(), v.token);
  const member = (await customer.circle(actors.a, r.id, {})).items.find((v) => v.role === 'EDITOR');
  await customer.revoke(actors.a, key(), r.id, member.id, { version: member.version });
  await rejects(() => customer.recipientDetail(actors.b, r.id), 'NOT_FOUND');
  r = await active();
  v = await invite(r);
  await customer.accept(actors.b, key(), v.token);
  await db
    .collection('care_recipients')
    .updateOne({ _id: r.id }, { $set: { consentExpiresAt: new Date(clock - 1) } });
  await rejects(() => customer.recipientDetail(actors.b, r.id), 'NOT_FOUND');
});
test('family withdrawal freezes reads and pending invitations immediately; staff confirms independently', async () => {
  let r = await active();
  const accepted = await invite(r);
  await customer.accept(actors.b, key(), accepted.token);
  r = await customer.recipientDetail(actors.a, r.id);
  const pending = await invite(r, 'VIEWER', ['RECIPIENT_DETAILS'], cPhone);
  r = await customer.recipientDetail(actors.a, r.id);
  const withdrawal = await customer.requestWithdrawal(actors.a, key(), r.id, {
    version: r.version,
    reasonCode: 'RECIPIENT_REQUESTED_CONTACT',
  });
  assert.equal(withdrawal.sharingFrozen, true);
  await rejects(() => customer.recipientDetail(actors.b, r.id), 'NOT_FOUND');
  await rejects(() => customer.accept(actors.c, key(), pending.token), 'CONSENT_REQUIRED');
  let row = await admin.claim(actors.reviewer, key(), withdrawal.id, { version: 1 });
  await rejects(
    () =>
      admin.withdrawal(actors.reviewer, key(), row.id, {
        version: row.version,
        independent: true,
        channelChecked: true,
        identityCheck: 'TWO_NON_SENSITIVE_FACTORS',
        evidenceReferences: ['TEST_ONLY_WITHDRAWAL'],
      }),
    'INDEPENDENT_CONTACT_REQUIRED',
  );
  row = await admin.contactAttempt(actors.reviewer, key(), row.id, {
    version: row.version,
    result: 'CONNECTED',
    method: 'DIRECT_PHONE',
    channelChecked: true,
  });
  await admin.withdrawal(actors.reviewer, key(), row.id, {
    version: row.version,
    independent: true,
    channelChecked: true,
    identityCheck: 'TWO_NON_SENSITIVE_FACTORS',
    evidenceReferences: ['TEST_ONLY_WITHDRAWAL'],
  });
  assert.equal((await customer.recipientDetail(actors.a, r.id)).state, 'CONSENT_WITHDRAWN');
  assert.equal(
    await db
      .collection('care_circle_memberships')
      .countDocuments({ recipientId: r.id, role: { $ne: 'STEWARD' }, status: 'ACTIVE' }),
    0,
  );
});
test('staff receipt of recipient withdrawal stops sharing without a family request', async () => {
  const r = await active(),
    v = await invite(r);
  await customer.accept(actors.b, key(), v.token);
  const previous = await db
    .collection('assisted_consent_cases')
    .findOne({ recipientId: r.id, state: 'APPROVED' });
  let row = await admin.withdrawalIntake(actors.reviewer, key(), previous._id, {
    version: previous.version,
    reasonCode: 'RECIPIENT_REQUESTED_CONTACT',
  });
  assert.equal(row.kind, 'WITHDRAWAL');
  assert.equal(row.state, 'ASSIGNED');
  await rejects(() => customer.recipientDetail(actors.b, r.id), 'NOT_FOUND');
  row = await admin.contactAttempt(actors.reviewer, key(), row.id, {
    version: row.version,
    result: 'CONNECTED',
    method: 'DIRECT_PHONE',
    channelChecked: true,
  });
  await admin.withdrawal(actors.reviewer, key(), row.id, {
    version: row.version,
    independent: true,
    channelChecked: true,
    identityCheck: 'TWO_NON_SENSITIVE_FACTORS',
    evidenceReferences: ['TEST_ONLY_STAFF_WITHDRAWAL'],
  });
  assert.equal((await customer.recipientDetail(actors.a, r.id)).state, 'CONSENT_WITHDRAWN');
});
test('concurrent invitation acceptance and withdrawal cannot retain shared access', async () => {
  const r = await active(),
    v = await invite(r);
  const fresh = await customer.recipientDetail(actors.a, r.id);
  await Promise.allSettled([
    customer.accept(actors.b, key(), v.token),
    customer.requestWithdrawal(actors.a, key(), r.id, {
      version: fresh.version,
      reasonCode: 'CORRECTION_REQUIRED',
    }),
  ]);
  const current = await customer.recipientDetail(actors.a, r.id);
  if (!current.sharingFrozen)
    await customer.requestWithdrawal(actors.a, key(), r.id, {
      version: current.version,
      reasonCode: 'CORRECTION_REQUIRED',
    });
  await rejects(() => customer.recipientDetail(actors.b, r.id), 'NOT_FOUND');
});
test('former family member cannot become reviewer and evidence/contact never enter support payloads', async () => {
  const r = await active(),
    v = await invite(r);
  await customer.accept(actors.b, key(), v.token);
  const support = await admin.support(actors.reviewer, {});
  assert.equal(JSON.stringify(support).includes('Short assistance preferences'), false);
  assert.equal(JSON.stringify(support).includes('contactPhone'), false);
  assert.equal(JSON.stringify(support).includes('line1'), false);
  const member = (await customer.circle(actors.a, r.id, {})).items.find((v) => v.role === 'EDITOR');
  await customer.revoke(actors.a, key(), r.id, member.id, { version: member.version });
  const c = await customer.requestWithdrawal(actors.a, key(), r.id, {
    version: (await customer.recipientDetail(actors.a, r.id)).version,
    reasonCode: 'CORRECTION_REQUIRED',
  });
  const fakeStaff = { ...actors.reviewer, user: { ...actors.reviewer.user, id: actors.b.user.id } };
  await db.collection('consent_staff_permissions').insertOne({
    _id: key(),
    identityId: actors.b.user.id,
    status: 'ACTIVE',
    capabilities: ['CONSENT_REVIEWER'],
    createdAt: new Date(clock),
    updatedAt: new Date(clock),
    version: 1,
  });
  await rejects(() => admin.claim(fakeStaff, key(), c.id, { version: 1 }), 'NOT_FOUND');
});
test('pagination is stable and privacy activity is scoped without protected payloads', async () => {
  const page = await customer.recipients(actors.a, { limit: 2 });
  assert.equal(page.items.length, 2);
  const next = await customer.recipients(actors.a, { limit: 2, cursor: page.nextCursor });
  assert.equal(
    next.items.some((v) => page.items.some((p) => p.id === v.id)),
    false,
  );
  const activity = await customer.activity(actors.c, {});
  assert.equal(
    activity.items.some((v) => v.action === 'PROFILE_UPDATED' && v.resourceId === actors.a.user.id),
    false,
  );
  assert.equal(JSON.stringify(activity).includes('responseSealed'), false);
});
test('actual HTTP guards reject unauthenticated/other-owner/forged inputs and preserve admin CSRF', async () => {
  const http = request(app.getHttpServer());
  if (backendRole === 'CUSTOMER') {
    const r = await recipient();
    await http.get('/v1/customer/recipients/' + r.id).expect(401);
    await http
      .get('/v1/customer/recipients/' + r.id)
      .set('Authorization', 'Bearer ' + tokens.b.accessToken)
      .expect(404);
    await http
      .patch('/v1/customer/profile')
      .set('Authorization', 'Bearer ' + tokens.a.accessToken)
      .set('Idempotency-Key', key())
      .send({
        version: 0,
        displayName: 'Test',
        preferredLanguage: 'English',
        phone: '+919990123456',
      })
      .expect(400);
    await http
      .patch('/v1/customer/recipients/' + r.id)
      .set('Authorization', 'Bearer ' + tokens.a.accessToken)
      .set('Idempotency-Key', key())
      .send({ version: r.version, state: 'ACTIVE' })
      .expect(400);
    await http
      .post('/v1/customer/recipients/' + r.id + '/consent-withdrawal')
      .set('Authorization', 'Bearer ' + tokens.a.accessToken)
      .send({})
      .expect(422);
  } else {
    const r = await recipient(),
      c = await requestCase(r),
      cookie = 'admin_access=' + encodeURIComponent(tokens.reviewer.accessToken);
    await http.get('/v1/admin/consent-cases').expect(401);
    await http
      .get('/v1/admin/consent-cases')
      .set('Cookie', 'admin_access=' + encodeURIComponent(tokens.ordinary.accessToken))
      .expect(403);
    await http
      .post('/v1/admin/consent-cases/' + c.id + '/claim')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:3000')
      .set('Idempotency-Key', key())
      .send({ version: 1 })
      .expect(403);
    await http
      .post('/v1/admin/consent-cases/' + c.id + '/claim')
      .set('Cookie', cookie)
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Token', tokens.reviewer.csrfToken)
      .set('Idempotency-Key', key())
      .send({ version: 1 })
      .expect(200);
  }
});
