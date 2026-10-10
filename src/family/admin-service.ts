import { z } from 'zod';
import type { ClientSession } from 'mongodb';
import { FamilyStore, type Actor, type Row } from './store';
import { DomainError } from './settings';
import * as C from './contracts';
export class ConsentAdminService extends FamilyStore {
  async staff(a: Actor, fresh = false) {
    if (this.authSettings.role !== 'ADMIN' || !a.session.mfa)
      throw new DomainError('FORBIDDEN', 403);
    const grant = await (
      await this.collection('consent_staff_permissions')
    ).findOne({
      identityId: a.user.id,
      status: 'ACTIVE',
      capabilities: { $in: ['CONSENT_REVIEWER', 'CONSENT_APPROVER'] },
    });
    if (!grant) throw new DomainError('CONSENT_PERMISSION_REQUIRED', 403);
    if (fresh && this.now() - a.session.createdAt.getTime() > this.settings.mfaSeconds * 1000)
      throw new DomainError('RECENT_MFA_REQUIRED', 403);
    return grant;
  }
  minimal(row: Row) {
    return {
      id: row._id,
      version: row.version,
      recipientId: row.recipientId,
      state: row.state,
      kind: row.kind,
      assignedReviewerId: row.assignedReviewerId,
      secondApproverId: row.secondApproverId,
      requestedScopes: row.requestedScopes,
      consentScopes: row.consentScopes,
      noticeVersion: row.noticeVersion,
      contactAttempts: row.contactAttempts,
      expiresAt: row.expiresAt,
      reasonCode: row.reasonCode ?? null,
    };
  }
  async caseRow(a: Actor, id: string, session?: ClientSession, fresh = true) {
    const grant = await this.staff(a, fresh);
    const conflicts = await (
      await this.collection('care_circle_memberships')
    ).distinct('recipientId', { identityId: a.user.id });
    const eligible = [];
    if (grant.capabilities.includes('CONSENT_REVIEWER'))
      eligible.push(
        { assignedReviewerId: a.user.id },
        { state: 'REQUESTED', assignedReviewerId: null },
      );
    if (grant.capabilities.includes('CONSENT_APPROVER'))
      eligible.push({ state: 'PENDING_SECOND_REVIEW' }, { secondApproverId: a.user.id });
    const row = await (
      await this.collection('assisted_consent_cases')
    ).findOne(
      { _id: id, stewardId: { $ne: a.user.id }, recipientId: { $nin: conflicts }, $or: eligible },
      session ? { session } : {},
    );
    if (!row) throw new DomainError('NOT_FOUND', 404);
    await this.caseConflict(a, row, session);
    return row;
  }
  async queue(a: Actor, q: unknown) {
    const grant = await this.staff(a),
      eligible = [];
    if (grant.capabilities.includes('CONSENT_REVIEWER'))
      eligible.push(
        { assignedReviewerId: a.user.id },
        { state: 'REQUESTED', assignedReviewerId: null },
      );
    if (grant.capabilities.includes('CONSENT_APPROVER'))
      eligible.push({ state: 'PENDING_SECOND_REVIEW' }, { secondApproverId: a.user.id });
    const query = C.listSchema.parse(q);
    if (
      query.state &&
      ![
        'REQUESTED',
        'ASSIGNED',
        'CONTACT_IN_PROGRESS',
        'EVIDENCE_RECORDED',
        'PENDING_SECOND_REVIEW',
        'APPROVED',
        'DECLINED',
        'UNVERIFIED',
        'NEEDS_MORE_EVIDENCE',
        'LAWFUL_AUTHORITY_REVIEW_REQUIRED',
        'CANCELLED',
      ].includes(query.state)
    )
      throw new DomainError('VALIDATION_ERROR', 400);
    const conflicts = await (
      await this.collection('care_circle_memberships')
    ).distinct('recipientId', { identityId: a.user.id });
    return this.page(
      'assisted_consent_cases',
      {
        $and: [
          { stewardId: { $ne: a.user.id }, recipientId: { $nin: conflicts }, $or: eligible },
          ...(query.state ? [{ state: query.state }] : []),
        ],
      },
      q,
      (row) => this.minimal(row),
    );
  }
  async detail(a: Actor, id: string) {
    const row = await this.caseRow(a, id);
    const grant = await this.staff(a, true),
      assigned = row.assignedReviewerId === a.user.id,
      approving =
        grant.capabilities.includes('CONSENT_APPROVER') &&
        row.state === 'PENDING_SECOND_REVIEW' &&
        row.assignedReviewerId !== a.user.id;
    await this.repo.transaction(async (session) => {
      await this.audit(a, 'CONSENT_CASE_VIEWED', row.recipientId, session, row._id);
    });
    const events = await (
      await this.collection('consent_review_events')
    )
      .find({ caseId: id })
      .sort({ createdAt: 1, _id: 1 })
      .limit(100)
      .toArray();
    const recipient =
      assigned || approving
        ? await (
            await this.collection('care_recipients')
          ).findOne(
            { _id: row.recipientId, stewardId: row.stewardId },
            { projection: { displayName: 1, adult: 1 } },
          )
        : null;
    return {
      ...this.minimal(row),
      recipientIdentity: recipient
        ? { displayName: recipient.displayName, adult: recipient.adult }
        : null,
      canClaim: row.state === 'REQUESTED' && grant.capabilities.includes('CONSENT_REVIEWER'),
      canReview: assigned,
      canDecide: approving,
      ...(assigned
        ? { contact: this.settings.unseal(row.contactSealed, 'case:' + id + ':contact') }
        : { contact: null }),
      ...((assigned || approving) && row.evidenceSealed
        ? { evidence: this.settings.unseal(row.evidenceSealed, 'case:' + id + ':evidence') }
        : { evidence: null }),
      policy: {
        maxAttempts: this.settings.maxAttempts,
        noticeVersion: this.settings.noticeVersion,
        caseDays: this.settings.caseDays,
        consentDays: this.settings.consentDays,
      },
      timeline: events.map((v) => ({
        id: v._id,
        action: v.action,
        actorId: v.actorId,
        createdAt: v.createdAt,
      })),
    };
  }
  open(row: Row, states: string[]) {
    if (!row.open || row.expiresAt.getTime() <= this.now())
      throw new DomainError('CASE_EXPIRED_OR_CLOSED', 422);
    if (!states.includes(row.state)) throw new DomainError('INVALID_TRANSITION', 422);
  }
  async claim(a: Actor, key: string, id: string, body: z.infer<typeof C.versionSchema>) {
    await this.admin(a, 'CONSENT_REVIEWER', true);
    await this.caseRow(a, id);
    return this.operation(a, key, 'claim:' + id, body, async (session) => {
      const row = await this.caseRow(a, id, session);
      this.open(row, ['REQUESTED']);
      if (row.assignedReviewerId) throw new DomainError('CASE_ALREADY_CLAIMED', 409);
      const updated = await this.change(
        'assisted_consent_cases',
        row,
        body.version,
        { assignedReviewerId: a.user.id, state: 'ASSIGNED', assignedAt: this.date() },
        session,
      );
      await this.audit(a, 'CASE_CLAIMED', row.recipientId, session, id);
      return this.minimal(updated);
    });
  }
  async contactAttempt(
    a: Actor,
    key: string,
    id: string,
    body: z.infer<typeof C.contactAttemptSchema>,
  ) {
    await this.admin(a, 'CONSENT_REVIEWER', true);
    await this.caseRow(a, id);
    return this.operation(a, key, 'contact-attempt:' + id, body, async (session) => {
      const row = await this.caseRow(a, id, session);
      this.open(row, ['ASSIGNED', 'CONTACT_IN_PROGRESS']);
      if (row.assignedReviewerId !== a.user.id) throw new DomainError('FORBIDDEN', 403);
      if (row.contactAttempts >= this.settings.maxAttempts)
        throw new DomainError('CONTACT_LIMIT', 429);
      const updated = await this.change(
        'assisted_consent_cases',
        row,
        body.version,
        { state: 'CONTACT_IN_PROGRESS', contactAttempts: row.contactAttempts + 1 },
        session,
      );
      await (
        await this.collection('consent_contact_attempts')
      ).insertOne(
        this.row({
          caseId: id,
          recipientId: row.recipientId,
          actorId: a.user.id,
          result: body.result,
          method: body.method,
          channelChecked: body.channelChecked,
        }),
        { session },
      );
      await this.audit(a, 'CONTACT_ATTEMPT_RECORDED', row.recipientId, session, id);
      return this.minimal(updated);
    });
  }
  async evidence(a: Actor, key: string, id: string, body: z.infer<typeof C.evidenceSchema>) {
    await this.admin(a, 'CONSENT_REVIEWER', true);
    await this.caseRow(a, id);
    return this.operation(a, key, 'evidence:' + id, body, async (session) => {
      const row = await this.caseRow(a, id, session);
      this.open(row, ['CONTACT_IN_PROGRESS']);
      if (row.assignedReviewerId !== a.user.id) throw new DomainError('FORBIDDEN', 403);
      if (
        body.noticeVersion !== row.noticeVersion ||
        body.noticeVersion !== this.settings.noticeVersion ||
        body.scopes.some((scope) => !row.requestedScopes.includes(scope))
      )
        throw new DomainError('NOTICE_OR_SCOPE_MISMATCH', 422);
      const { version, ...evidence } = body;
      const updated = await this.change(
        'assisted_consent_cases',
        row,
        version,
        {
          state: 'EVIDENCE_RECORDED',
          evidenceSealed: this.settings.seal(evidence, 'case:' + id + ':evidence'),
          evidenceAt: this.date(),
          reviewerMfaAt: a.session.createdAt,
        },
        session,
      );
      await this.audit(a, 'INDEPENDENT_EVIDENCE_RECORDED', row.recipientId, session, id);
      return this.minimal(updated);
    });
  }
  async submit(a: Actor, key: string, id: string, body: z.infer<typeof C.versionSchema>) {
    await this.admin(a, 'CONSENT_REVIEWER', true);
    await this.caseRow(a, id);
    return this.operation(a, key, 'submit-review:' + id, body, async (session) => {
      const row = await this.caseRow(a, id, session);
      this.open(row, ['EVIDENCE_RECORDED']);
      if (row.assignedReviewerId !== a.user.id || !row.evidenceSealed)
        throw new DomainError('FORBIDDEN', 403);
      const updated = await this.change(
        'assisted_consent_cases',
        row,
        body.version,
        { state: 'PENDING_SECOND_REVIEW', submittedAt: this.date() },
        session,
      );
      await this.audit(a, 'SECOND_REVIEW_REQUESTED', row.recipientId, session, id);
      return this.minimal(updated);
    });
  }
  async sufficient(row: Row, session: ClientSession) {
    if (!row.evidenceSealed) return false;
    const evidence = C.evidenceSchema
      .omit({ version: true })
      .safeParse(this.settings.unseal(row.evidenceSealed, 'case:' + row._id + ':evidence'));
    if (!evidence.success) return false;
    const e = evidence.data;
    const reviewer = await (
      await this.collection('consent_staff_permissions')
    ).findOne(
      { identityId: row.assignedReviewerId, status: 'ACTIVE', capabilities: 'CONSENT_REVIEWER' },
      { session },
    );
    const identity = await (
      await this.collection('identities')
    ).findOne({ _id: row.assignedReviewerId, status: 'ACTIVE' }, { session });
    const adminMembership = await (
      await this.collection('role_memberships')
    ).findOne(
      {
        identityId: row.assignedReviewerId,
        role: { $in: ['ADMIN', 'SUPER_ADMIN'] },
        status: 'ACTIVE',
      },
      { session },
    );
    const attempt = await (
      await this.collection('consent_contact_attempts')
    ).findOne(
      {
        caseId: row._id,
        actorId: row.assignedReviewerId,
        result: 'CONNECTED',
        channelChecked: true,
        method: e.verificationMethod,
      },
      { session },
    );
    return Boolean(
      row.independentConsentPossible &&
      reviewer &&
      identity &&
      adminMembership &&
      attempt &&
      e.outcome === 'AFFIRMATIVE' &&
      e.independent &&
      e.understood &&
      e.conflictFree &&
      e.disclosedCategories &&
      e.disclosedPurpose &&
      e.withdrawalExplained &&
      e.identityCheck !== 'NOT_ESTABLISHED' &&
      e.comprehensionCheck !== 'NOT_ESTABLISHED' &&
      e.scopes.includes('RECIPIENT_DETAILS') &&
      e.evidenceReferences.length &&
      e.noticeVersion === this.settings.noticeVersion &&
      row.reviewerMfaAt &&
      row.evidenceAt.getTime() - row.reviewerMfaAt.getTime() <= this.settings.mfaSeconds * 1000,
    );
  }
  async decision(a: Actor, key: string, id: string, body: z.infer<typeof C.decisionSchema>) {
    await this.admin(a, 'CONSENT_APPROVER', true);
    await this.caseRow(a, id);
    return this.operation(a, key, 'decision:' + id, body, async (session) => {
      const row = await this.caseRow(a, id, session);
      this.open(row, ['PENDING_SECOND_REVIEW']);
      if (row.assignedReviewerId === a.user.id) throw new DomainError('TWO_PERSON_RULE', 403);
      if (row.kind !== 'ACTIVATION') throw new DomainError('INVALID_TRANSITION', 422);
      const recipients = await this.collection('care_recipients'),
        recipient = await recipients.findOne(
          { _id: row.recipientId, stewardId: row.stewardId, state: 'PENDING_CONSENT' },
          { session },
        );
      if (!recipient) throw new DomainError('INVALID_TRANSITION', 422);
      let state: string =
        body.outcome === 'APPROVE'
          ? 'APPROVED'
          : body.outcome === 'DECLINE'
            ? 'DECLINED'
            : body.outcome;
      if (body.outcome === 'APPROVE') {
        if (
          body.reasonCode !== 'SUFFICIENT_INDEPENDENT_EVIDENCE' ||
          !(await this.sufficient(row, session))
        )
          throw new DomainError('INSUFFICIENT_INDEPENDENT_EVIDENCE', 422);
        const e = C.evidenceSchema
          .omit({ version: true })
          .parse(this.settings.unseal(row.evidenceSealed, 'case:' + id + ':evidence'));
        const expiresAt = new Date(this.now() + this.settings.consentDays * 86400000);
        await this.change(
          'care_recipients',
          recipient,
          recipient.version,
          {
            state: 'ACTIVE',
            sharingFrozen: false,
            withdrawalPending: false,
            sharedWith: [],
            consentScopes: e.scopes,
            consentExpiresAt: expiresAt,
            activeConsentCaseId: id,
          },
          session,
        );
        await (
          await this.collection('recipient_consents')
        ).insertOne(
          this.row({
            recipientId: row.recipientId,
            caseId: id,
            status: 'APPROVED',
            scopes: e.scopes,
            noticeVersion: row.noticeVersion,
            reviewerId: row.assignedReviewerId,
            approverId: a.user.id,
            approvedAt: this.date(),
            expiresAt,
            evidenceSealed: row.evidenceSealed,
            evidenceContext: 'case:' + id + ':evidence',
          }),
          { session },
        );
        row.consentScopes = e.scopes;
      } else {
        if (body.outcome === 'DECLINE') {
          const e = row.evidenceSealed
            ? C.evidenceSchema
                .omit({ version: true })
                .parse(this.settings.unseal(row.evidenceSealed, 'case:' + id + ':evidence'))
            : null;
          if (e?.outcome !== 'DECLINED' || body.reasonCode !== 'RECIPIENT_DECLINED')
            throw new DomainError('DECLINE_EVIDENCE_REQUIRED', 422);
        }
        if (!row.independentConsentPossible) state = 'LAWFUL_AUTHORITY_REVIEW_REQUIRED';
        await this.freeze(a, recipient, recipient.version, { state: 'PENDING_CONSENT' }, session);
      }
      const updated = await this.change(
        'assisted_consent_cases',
        row,
        body.version,
        {
          state,
          open: false,
          secondApproverId: a.user.id,
          consentScopes: row.consentScopes,
          reasonCode: body.reasonCode,
          decidedAt: this.date(),
          approverMfaAt: a.session.createdAt,
        },
        session,
      );
      await this.audit(a, 'CONSENT_DECISION_' + state, row.recipientId, session, id);
      return this.minimal(updated);
    });
  }
  async withdrawal(a: Actor, key: string, id: string, body: z.infer<typeof C.staffWithdrawal>) {
    await this.admin(a, 'CONSENT_REVIEWER', true);
    await this.caseRow(a, id);
    return this.operation(a, key, 'staff-withdrawal:' + id, body, async (session) => {
      const row = await this.caseRow(a, id, session);
      if (row.assignedReviewerId !== a.user.id) throw new DomainError('FORBIDDEN', 403);
      if (row.version !== body.version) throw new DomainError('VERSION_CONFLICT', 409);
      const attempt = await (
        await this.collection('consent_contact_attempts')
      ).findOne(
        { caseId: id, actorId: a.user.id, result: 'CONNECTED', channelChecked: true },
        { session },
      );
      if (!attempt) throw new DomainError('INDEPENDENT_CONTACT_REQUIRED', 422);
      if (row.kind !== 'WITHDRAWAL') throw new DomainError('WITHDRAWAL_CASE_REQUIRED', 422);
      this.open(row, ['CONTACT_IN_PROGRESS', 'EVIDENCE_RECORDED']);
      const recipient = await (
        await this.collection('care_recipients')
      ).findOne(
        { _id: row.recipientId, stewardId: row.stewardId, state: { $ne: 'ARCHIVED' } },
        { session },
      );
      if (!recipient) throw new DomainError('NOT_FOUND', 404);
      await this.freeze(
        a,
        recipient,
        recipient.version,
        {
          state: 'CONSENT_WITHDRAWN',
          consentScopes: [],
          consentExpiresAt: null,
          withdrawalPending: false,
          withdrawnAt: this.date(),
        },
        session,
      );
      await (
        await this.collection('recipient_consents')
      ).updateMany(
        { recipientId: row.recipientId, status: 'APPROVED' },
        {
          $set: { status: 'WITHDRAWN', withdrawnAt: this.date(), updatedAt: this.date() },
          $inc: { version: 1 },
        },
        { session },
      );
      const updated = await this.change(
        'assisted_consent_cases',
        row,
        body.version,
        {
          state: 'CANCELLED',
          open: false,
          reasonCode: 'RECIPIENT_WITHDREW',
          withdrawalSealed: this.settings.seal(body, 'case:' + id + ':withdrawal'),
          withdrawnAt: this.date(),
        },
        session,
      );
      await this.audit(a, 'INDEPENDENT_WITHDRAWAL_CONFIRMED', row.recipientId, session, id);
      return this.minimal(updated);
    });
  }
  async withdrawalIntake(
    a: Actor,
    key: string,
    id: string,
    body: z.infer<typeof C.withdrawalRequest>,
  ) {
    await this.admin(a, 'CONSENT_REVIEWER', true);
    await this.caseRow(a, id);
    return this.operation(a, key, 'staff-withdrawal-intake:' + id, body, async (session) => {
      const previous = await this.caseRow(a, id, session);
      if (previous.assignedReviewerId !== a.user.id) throw new DomainError('FORBIDDEN', 403);
      if (previous.version !== body.version) throw new DomainError('VERSION_CONFLICT', 409);
      const recipient = await (
        await this.collection('care_recipients')
      ).findOne(
        { _id: previous.recipientId, stewardId: previous.stewardId, state: { $ne: 'ARCHIVED' } },
        { session },
      );
      if (!recipient) throw new DomainError('NOT_FOUND', 404);
      const cases = await this.collection('assisted_consent_cases');
      await cases.updateMany(
        { recipientId: recipient._id, open: true },
        { $set: { state: 'CANCELLED', open: false, updatedAt: this.date() }, $inc: { version: 1 } },
        { session },
      );
      await this.freeze(a, recipient, recipient.version, { withdrawalPending: true }, session);
      const row = this.row({
        recipientId: recipient._id,
        stewardId: recipient.stewardId,
        kind: 'WITHDRAWAL',
        state: 'ASSIGNED',
        open: true,
        assignedReviewerId: a.user.id,
        assignedAt: this.date(),
        secondApproverId: null,
        requestedScopes: [],
        consentScopes: [],
        noticeVersion: this.settings.noticeVersion,
        contactAttempts: 0,
        reasonCode: body.reasonCode,
        expiresAt: new Date(this.now() + this.settings.caseDays * 86400000),
        withdrawalSourceCaseId: previous._id,
      });
      row.contactSealed = this.settings.seal(
        this.settings.unseal(previous.contactSealed, 'case:' + previous._id + ':contact'),
        'case:' + row._id + ':contact',
      );
      await cases.insertOne(row, { session });
      await this.audit(a, 'STAFF_WITHDRAWAL_RECEIVED', recipient._id, session, row._id);
      return this.minimal(row);
    });
  }
  async support(a: Actor, q: unknown) {
    await this.admin(a, 'SUPPORT_VIEWER');
    return this.page('care_recipients', { state: { $ne: 'ARCHIVED' } }, q, (row) => ({
      id: row._id,
      version: row.version,
      nameLabel: row.displayName.slice(0, 1) + '***',
      state: row.state,
      sharingFrozen: row.sharingFrozen,
      consentExpiresAt: row.consentExpiresAt ?? null,
    }));
  }
}
