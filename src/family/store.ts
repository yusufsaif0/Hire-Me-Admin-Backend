import { randomUUID } from 'node:crypto';
import type { ClientSession, Document, Filter } from 'mongodb';
import { AuthRepository } from '../auth/repository';
import { AuthService } from '../auth/service';
import { AuthSettings } from '../auth/settings';
import { DomainError, FamilySettings } from './settings';
import { listSchema } from './contracts';
export type Actor = Awaited<ReturnType<AuthService['authenticate']>>;
export type Row = Document & { _id: string; createdAt: Date; updatedAt: Date; version: number };
export class FamilyStore {
  constructor(
    readonly authSettings: AuthSettings,
    readonly repo: AuthRepository,
    readonly settings: FamilySettings,
    readonly now: () => number = Date.now,
  ) {}
  date() {
    return new Date(this.now());
  }
  row(fields: Document): Row {
    return {
      _id: randomUUID(),
      createdAt: this.date(),
      updatedAt: this.date(),
      version: 1,
      ...fields,
    };
  }
  async ready() {
    this.settings.ready();
    try {
      const db = await this.repo.ready();
      if (!(await db.collection('schema_migrations').findOne({ version: '0002' })))
        throw new Error();
      return db;
    } catch {
      throw new DomainError('DOMAIN_UNAVAILABLE', 503);
    }
  }
  async collection(name: string) {
    return (await this.ready()).collection<Row>(name);
  }
  customer(a: Actor) {
    if (this.authSettings.role !== 'CUSTOMER' || a.session.role !== 'CUSTOMER')
      throw new DomainError('FORBIDDEN', 403);
    return a.user.id;
  }
  async admin(a: Actor, capability: string, fresh = false) {
    if (
      this.authSettings.role !== 'ADMIN' ||
      !a.session.mfa ||
      !['ADMIN', 'SUPER_ADMIN'].includes(a.session.role)
    )
      throw new DomainError('FORBIDDEN', 403);
    const grant = await (
      await this.collection('consent_staff_permissions')
    ).findOne({ identityId: a.user.id, status: 'ACTIVE', capabilities: capability });
    if (!grant) throw new DomainError('CONSENT_PERMISSION_REQUIRED', 403);
    if (fresh && this.now() - a.session.createdAt.getTime() > this.settings.mfaSeconds * 1000)
      throw new DomainError('RECENT_MFA_REQUIRED', 403);
    return a.user.id;
  }
  async audit(
    a: Actor,
    action: string,
    resourceId: string,
    session: ClientSession,
    caseId?: string,
  ) {
    const row = this.row({ actorId: a.user.id, action, resourceId, ...(caseId ? { caseId } : {}) });
    await (await this.collection('privacy_audit_events')).insertOne(row, { session });
    if (caseId)
      await (
        await this.collection('consent_review_events')
      ).insertOne(this.row({ actorId: a.user.id, action, resourceId, caseId }), { session });
  }
  async operation(
    a: Actor,
    key: string,
    operation: string,
    body: unknown,
    fn: (session: ClientSession) => Promise<unknown>,
  ) {
    await this.ready();
    if (!/^[a-f0-9-]{36}$/i.test(key)) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400);
    const fingerprint = this.settings.digest(JSON.stringify(body));
    try {
      return await this.repo.transaction(async (session) => {
        const operations = await this.collection('phase2_operations');
        const old = await operations.findOne({ actorId: a.user.id, key, operation }, { session });
        if (old) {
          if (old.fingerprint !== fingerprint) throw new DomainError('IDEMPOTENCY_CONFLICT', 409);
          return this.settings.unseal(old.responseSealed, 'operation:' + old._id);
        }
        const result = JSON.parse(JSON.stringify(await fn(session))) as unknown;
        const entry = this.row({ actorId: a.user.id, key, operation, fingerprint });
        entry.responseSealed = this.settings.seal(result, 'operation:' + entry._id);
        await operations.insertOne(entry, { session });
        return result;
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000)
        throw new DomainError('DUPLICATE', 409);
      throw error;
    }
  }
  async rate(a: Actor, kind: string, session: ClientSession) {
    const bucket = Math.floor(this.now() / 3600000),
      c = await this.collection('phase2_rate_limits');
    const row = await c.findOneAndUpdate(
      { actorId: a.user.id, kind, bucket },
      {
        $setOnInsert: { _id: randomUUID(), createdAt: this.date(), version: 1 },
        $set: { updatedAt: this.date() },
        $inc: { count: 1 },
      },
      { upsert: true, returnDocument: 'after', session },
    );
    if ((row?.count ?? 0) > this.settings.requestLimit) throw new DomainError('RATE_LIMITED', 429);
  }
  async change(name: string, row: Row, version: number, fields: Document, session: ClientSession) {
    const changed = await (
      await this.collection(name)
    ).findOneAndUpdate(
      { _id: row._id, version },
      { $set: { ...fields, updatedAt: this.date() }, $inc: { version: 1 } },
      { returnDocument: 'after', session },
    );
    if (!changed) throw new DomainError('VERSION_CONFLICT', 409);
    return changed;
  }
  async page(name: string, filter: Filter<Row>, input: unknown, project: (row: Row) => unknown) {
    const query = listSchema.parse(input);
    let cursorFilter: Filter<Row> = {};
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        if (!/^[a-f0-9-]{36}$/i.test(cursor.id) || !Number.isFinite(Date.parse(cursor.at)))
          throw new Error();
        const at = new Date(cursor.at);
        cursorFilter = {
          $or: [{ createdAt: { $gt: at } }, { createdAt: at, _id: { $gt: cursor.id } }],
        };
      } catch {
        throw new DomainError('INVALID_CURSOR', 400);
      }
    }
    const rows = await (
      await this.collection(name)
    )
      .find({ $and: [filter, cursorFilter] })
      .sort({ createdAt: 1, _id: 1 })
      .limit(query.limit + 1)
      .toArray();
    const visible = rows.slice(0, query.limit),
      last = visible.at(-1);
    return {
      items: visible.map(project),
      nextCursor:
        rows.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.createdAt.toISOString(), id: last._id }),
            ).toString('base64url')
          : null,
    };
  }
  sharingFilter(a: Actor, scope = 'RECIPIENT_DETAILS'): Filter<Row> {
    return {
      $or: [
        { stewardId: a.user.id },
        {
          state: 'ACTIVE',
          sharingFrozen: false,
          consentExpiresAt: { $gt: this.date() },
          sharedWith: { $elemMatch: { identityId: a.user.id, scopes: scope } },
        },
      ],
    };
  }
  async recipient(a: Actor, id: string, session?: ClientSession, scope = 'RECIPIENT_DETAILS') {
    this.customer(a);
    const row = await (
      await this.collection('care_recipients')
    ).findOne(
      { $and: [{ _id: id, state: { $ne: 'ARCHIVED' } }, this.sharingFilter(a, scope)] },
      session ? { session } : {},
    );
    if (!row) throw new DomainError('NOT_FOUND', 404);
    return row;
  }
  role(a: Actor, row: Row): string {
    return row.stewardId === a.user.id
      ? 'STEWARD'
      : (row.sharedWith.find((v: Document) => v.identityId === a.user.id)?.role ?? 'NONE');
  }
  steward(a: Actor, row: Row) {
    if (row.stewardId !== a.user.id) throw new DomainError('FORBIDDEN', 403);
  }
  editor(a: Actor, row: Row) {
    if (!['STEWARD', 'EDITOR'].includes(this.role(a, row))) throw new DomainError('FORBIDDEN', 403);
  }
  active(row: Row) {
    if (
      row.state !== 'ACTIVE' ||
      row.sharingFrozen ||
      !row.consentExpiresAt ||
      row.consentExpiresAt.getTime() <= this.now()
    )
      throw new DomainError('CONSENT_REQUIRED', 422);
  }
  async freeze(a: Actor, row: Row, version: number, fields: Document, session: ClientSession) {
    const updated = await this.change(
      'care_recipients',
      row,
      version,
      { sharingFrozen: true, sharedWith: [], ...fields },
      session,
    );
    await (
      await this.collection('care_circle_invitations')
    ).updateMany(
      { recipientId: row._id, status: 'PENDING' },
      { $set: { status: 'REVOKED', updatedAt: this.date() }, $inc: { version: 1 } },
      { session },
    );
    await (
      await this.collection('care_circle_memberships')
    ).updateMany(
      { recipientId: row._id, role: { $ne: 'STEWARD' }, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', updatedAt: this.date() }, $inc: { version: 1 } },
      { session },
    );
    await this.audit(a, 'SHARING_BLOCKED', row._id, session);
    return updated;
  }
  async caseConflict(a: Actor, row: Row, session?: ClientSession) {
    if (row.stewardId === a.user.id) throw new DomainError('REVIEWER_CONFLICT', 403);
    const member = await (
      await this.collection('care_circle_memberships')
    ).findOne({ recipientId: row.recipientId, identityId: a.user.id }, session ? { session } : {});
    if (member) throw new DomainError('REVIEWER_CONFLICT', 403);
  }
}
