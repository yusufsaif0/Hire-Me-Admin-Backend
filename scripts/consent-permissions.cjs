require('dotenv/config');
const readline = require('node:readline/promises'),
  { randomUUID } = require('node:crypto');
const { AuthSettings } = require('../dist/auth/settings'),
  { AuthRepository } = require('../dist/auth/repository');
const { FamilySettings } = require('../dist/family/settings'),
  { phoneSchema } = require('../dist/auth/contracts');
(async () => {
  const settings = new AuthSettings('ADMIN');
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    settings.env.NODE_ENV !== 'development' ||
    settings.env.HOST !== '127.0.0.1'
  )
    throw new Error('Private local development terminal required');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout }),
    repo = new AuthRepository(settings);
  try {
    new FamilySettings().ready();
    const db = await repo.ready();
    if (!(await db.collection('schema_migrations').findOne({ version: '0002' })))
      throw new Error('Migration 0002 required');
    const phone = phoneSchema.parse(await rl.question('Existing admin phone (private): '));
    const role = (
      await rl.question('Permission: reviewer, approver, both, support, or revoke: ')
    ).trim();
    const capabilities =
      role === 'reviewer'
        ? ['CONSENT_REVIEWER', 'SUPPORT_VIEWER']
        : role === 'approver'
          ? ['CONSENT_APPROVER', 'SUPPORT_VIEWER']
          : role === 'both'
            ? ['CONSENT_REVIEWER', 'CONSENT_APPROVER', 'SUPPORT_VIEWER']
            : role === 'support'
              ? ['SUPPORT_VIEWER']
              : role === 'revoke'
                ? []
                : null;
    if (!capabilities) throw new Error('Invalid permission');
    const identity = await db.collection('identities').findOne({ phone, status: 'ACTIVE' });
    const member = identity
      ? await db.collection('role_memberships').findOne({
          identityId: identity._id,
          role: { $in: ['ADMIN', 'SUPER_ADMIN'] },
          status: 'ACTIVE',
        })
      : null;
    if (!member) throw new Error('Existing active admin required');
    const now = new Date();
    await db.collection('consent_staff_permissions').updateOne(
      { identityId: identity._id },
      {
        $setOnInsert: { _id: randomUUID(), createdAt: now },
        $set: {
          updatedAt: now,
          capabilities,
          status: capabilities.length ? 'ACTIVE' : 'REVOKED',
        },
        $inc: { version: 1 },
      },
      { upsert: true },
    );
    await db.collection('privacy_audit_events').insertOne({
      _id: randomUUID(),
      actorId: 'LOCAL_OPERATOR',
      action: 'CONSENT_PERMISSION_CHANGED',
      resourceId: identity._id,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    console.log(
      'Explicit consent permissions updated. Existing authentication credentials unchanged.',
    );
  } finally {
    rl.close();
    await repo.onModuleDestroy();
  }
})().catch(() => {
  console.error(
    'Consent permission update failed. Requires a private development terminal, migration 0002 and existing admin. No private values printed.',
  );
  process.exitCode = 1;
});
