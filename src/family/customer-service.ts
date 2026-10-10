import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ClientSession, Document } from 'mongodb';
import { maskPhone } from '../auth/contracts';
import { FamilyStore, type Actor, type Row } from './store';
import { DomainError } from './settings';
import * as C from './contracts';
export class CustomerFamilyService extends FamilyStore {
  policy() {
    return {
      noticeVersion: this.settings.noticeVersion,
      development: true,
      scopes: C.scopes,
      caseDays: this.settings.caseDays,
      consentDays: this.settings.consentDays,
      notice:
        'Optional family sharing of recipient details, emergency contacts and explicitly selected assistance preferences. No bookings, clinical records or automated contact. Staff independently verifies the adult recipient and a second authorized person reviews the evidence. Sharing can be stopped through the verified withdrawal process. This development notice requires review before a pilot.',
    };
  }
  async profile(a: Actor) {
    this.customer(a);
    const row = await (await this.collection('customer_profiles')).findOne({ ownerId: a.user.id });
    return row
      ? {
          id: row._id,
          version: row.version,
          displayName: row.displayName,
          preferredLanguage: row.preferredLanguage,
          maskedPhone: a.user.maskedPhone,
          policy: this.policy(),
        }
      : {
          id: null,
          version: 0,
          displayName: '',
          preferredLanguage: 'English',
          maskedPhone: a.user.maskedPhone,
          policy: this.policy(),
        };
  }
  async saveProfile(a: Actor, key: string, body: z.infer<typeof C.profileSchema>) {
    this.customer(a);
    return this.operation(a, key, 'profile', body, async (session) => {
      const c = await this.collection('customer_profiles'),
        row = await c.findOne({ ownerId: a.user.id }, { session });
      if (row)
        await this.change(
          'customer_profiles',
          row,
          body.version,
          { displayName: body.displayName, preferredLanguage: body.preferredLanguage },
          session,
        );
      else {
        if (body.version !== 0) throw new DomainError('VERSION_CONFLICT', 409);
        await c.insertOne(
          this.row({
            ownerId: a.user.id,
            displayName: body.displayName,
            preferredLanguage: body.preferredLanguage,
          }),
          { session },
        );
      }
      await this.audit(a, 'PROFILE_UPDATED', a.user.id, session);
      const saved = await c.findOne({ ownerId: a.user.id }, { session });
      return {
        id: saved!._id,
        version: saved!.version,
        displayName: saved!.displayName,
        preferredLanguage: saved!.preferredLanguage,
        maskedPhone: a.user.maskedPhone,
        policy: this.policy(),
      };
    });
  }
  addressDto(row: Row) {
    const { _id, version, label, line1, line2, locality, city, state, postalCode, country, point } =
      row;
    return {
      id: _id,
      version,
      label,
      line1,
      line2,
      locality,
      city,
      state,
      postalCode,
      country,
      point,
    };
  }
  async addresses(a: Actor, q: unknown) {
    this.customer(a);
    return this.page('customer_addresses', { ownerId: a.user.id, archivedAt: null }, q, (row) =>
      this.addressDto(row),
    );
  }
  async address(a: Actor, id: string) {
    this.customer(a);
    const row = await (
      await this.collection('customer_addresses')
    ).findOne({ _id: id, ownerId: a.user.id, archivedAt: null });
    if (!row) throw new DomainError('NOT_FOUND', 404);
    return this.addressDto(row);
  }
  async writeAddress(a: Actor, key: string, id: string | null, body: Document, archive = false) {
    this.customer(a);
    return this.operation(
      a,
      key,
      'address:' + (id ?? 'new') + ':' + archive,
      body,
      async (session) => {
        const c = await this.collection('customer_addresses');
        let row: Row;
        if (id) {
          const current = await c.findOne(
            { _id: id, ownerId: a.user.id, archivedAt: null },
            { session },
          );
          if (!current) throw new DomainError('NOT_FOUND', 404);
          const { version, ...fields } = body;
          row = await this.change(
            'customer_addresses',
            current,
            version,
            archive ? { archivedAt: this.date() } : fields,
            session,
          );
        } else {
          row = this.row({ ...body, ownerId: a.user.id, archivedAt: null });
          await c.insertOne(row, { session });
        }
        await this.audit(a, archive ? 'ADDRESS_ARCHIVED' : 'ADDRESS_SAVED', row._id, session);
        return this.addressDto(row);
      },
    );
  }
  recipientDto(a: Actor, row: Row, detail = false) {
    const role = this.role(a, row),
      own = role === 'STEWARD',
      notesAllowed =
        own ||
        (role === 'EDITOR' &&
          row.sharedWith.some(
            (v: Document) => v.identityId === a.user.id && v.scopes.includes('ASSISTANCE_NOTES'),
          ));
    return {
      id: row._id,
      version: row.version,
      displayName: row.displayName,
      relationship: row.relationship,
      adult: row.adult,
      preferredLanguage: row.preferredLanguage,
      communicationNeeds: row.communicationNeeds,
      state: row.state,
      sharingFrozen: row.sharingFrozen,
      consentScopes: row.consentScopes ?? [],
      consentExpiresAt: row.consentExpiresAt ?? null,
      role,
      ...(detail && notesAllowed
        ? {
            assistanceNotes: row.notesSealed
              ? this.settings.unseal(row.notesSealed, 'recipient:' + row._id + ':notes')
              : '',
          }
        : {}),
    };
  }
  async recipients(a: Actor, q: unknown) {
    this.customer(a);
    return this.page(
      'care_recipients',
      { $and: [{ state: { $ne: 'ARCHIVED' } }, this.sharingFilter(a)] },
      q,
      (row) => this.recipientDto(a, row),
    );
  }
  async recipientDetail(a: Actor, id: string) {
    return this.recipientDto(a, await this.recipient(a, id), true);
  }
  async writeRecipient(a: Actor, key: string, id: string | null, body: Document, archive = false) {
    this.customer(a);
    if (id) {
      const current = archive
        ? await (
            await this.collection('care_recipients')
          ).findOne({ _id: id, stewardId: a.user.id })
        : await this.recipient(a, id);
      if (!current) throw new DomainError('NOT_FOUND', 404);
      if (archive) this.steward(a, current);
      else this.editor(a, current);
    }
    return this.operation(
      a,
      key,
      'recipient:' + (id ?? 'new') + ':' + archive,
      body,
      async (session) => {
        let row: Row;
        if (id) {
          const current = await this.recipient(a, id, session);
          if (archive) this.steward(a, current);
          else this.editor(a, current);
          const { version, assistanceNotes, ...fields } = body;
          if (fields.state) {
            this.steward(a, current);
            if (current.state !== 'DRAFT' || fields.state !== 'PENDING_CONSENT')
              throw new DomainError('INVALID_TRANSITION', 422);
          }
          if (assistanceNotes !== undefined) {
            if (
              this.role(a, current) !== 'STEWARD' &&
              !current.sharedWith.some(
                (v: Document) =>
                  v.identityId === a.user.id && v.scopes.includes('ASSISTANCE_NOTES'),
              )
            )
              throw new DomainError('FIELD_SCOPE_REQUIRED', 403);
            fields.notesSealed = this.settings.seal(assistanceNotes, 'recipient:' + id + ':notes');
          }
          row = archive
            ? await this.freeze(
                a,
                current,
                version,
                { state: 'ARCHIVED', archivedAt: this.date() },
                session,
              )
            : await this.change('care_recipients', current, version, fields, session);
          if (archive)
            await (
              await this.collection('assisted_consent_cases')
            ).updateMany(
              { recipientId: id, open: true },
              {
                $set: { state: 'CANCELLED', open: false, updatedAt: this.date() },
                $inc: { version: 1 },
              },
              { session },
            );
        } else {
          const { assistanceNotes, ...fields } = body;
          row = this.row({
            ...fields,
            stewardId: a.user.id,
            sharingFrozen: true,
            sharedWith: [],
            consentScopes: [],
            consentExpiresAt: null,
            archivedAt: null,
          });
          if (assistanceNotes !== undefined)
            row.notesSealed = this.settings.seal(
              assistanceNotes,
              'recipient:' + row._id + ':notes',
            );
          await (await this.collection('care_recipients')).insertOne(row, { session });
          await (
            await this.collection('care_circle_memberships')
          ).insertOne(
            this.row({
              recipientId: row._id,
              identityId: a.user.id,
              role: 'STEWARD',
              scopes: [...C.scopes],
              status: 'ACTIVE',
            }),
            { session },
          );
        }
        await this.audit(a, archive ? 'RECIPIENT_ARCHIVED' : 'RECIPIENT_SAVED', row._id, session);
        return this.recipientDto(a, row, !archive);
      },
    );
  }
  contactDto(row: Row) {
    return {
      id: row._id,
      version: row.version,
      displayName: row.displayName,
      relationship: row.relationship,
      maskedPhone: row.maskedPhone,
    };
  }
  async contacts(a: Actor, id: string, q: unknown) {
    await this.recipient(a, id, undefined, 'EMERGENCY_CONTACTS');
    return this.page('emergency_contacts', { recipientId: id, archivedAt: null }, q, (row) =>
      this.contactDto(row),
    );
  }
  async writeContact(
    a: Actor,
    key: string,
    id: string,
    contactId: string | null,
    body: Document,
    archive = false,
  ) {
    this.customer(a);
    this.editor(a, await this.recipient(a, id, undefined, 'EMERGENCY_CONTACTS'));
    return this.operation(
      a,
      key,
      'contact:' + id + ':' + (contactId ?? 'new') + ':' + archive,
      body,
      async (session) => {
        const recipient = await this.recipient(a, id, session, 'EMERGENCY_CONTACTS');
        this.editor(a, recipient);
        await this.change('care_recipients', recipient, recipient.version, {}, session);
        const c = await this.collection('emergency_contacts');
        let row: Row;
        const { version, phone, ...fields } = body;
        if (contactId) {
          const current = await c.findOne(
            { _id: contactId, recipientId: id, archivedAt: null },
            { session },
          );
          if (!current) throw new DomainError('NOT_FOUND', 404);
          if (phone) {
            fields.phoneSealed = this.settings.seal(phone, 'contact:' + contactId);
            fields.maskedPhone = maskPhone(phone);
          }
          row = await this.change(
            'emergency_contacts',
            current,
            version,
            archive ? { archivedAt: this.date() } : fields,
            session,
          );
        } else {
          row = this.row({
            ...fields,
            recipientId: id,
            ownerId: recipient.stewardId,
            archivedAt: null,
            maskedPhone: maskPhone(phone),
          });
          row.phoneSealed = this.settings.seal(phone, 'contact:' + row._id);
          await c.insertOne(row, { session });
        }
        await this.audit(a, archive ? 'CONTACT_ARCHIVED' : 'CONTACT_SAVED', id, session);
        return this.contactDto(row);
      },
    );
  }
  async consent(a: Actor, id: string) {
    const recipient = await this.recipient(a, id);
    const row = await (
      await this.collection('assisted_consent_cases')
    )
      .find({ recipientId: id, stewardId: recipient.stewardId })
      .sort({ createdAt: -1, _id: -1 })
      .limit(1)
      .next();
    return {
      recipientId: id,
      version: recipient.version,
      state: recipient.state,
      sharingFrozen: recipient.sharingFrozen,
      scopes: recipient.consentScopes ?? [],
      expiresAt: recipient.consentExpiresAt ?? null,
      noticeVersion: this.settings.noticeVersion,
      case: row
        ? {
            id: row._id,
            version: row.version,
            state: row.state,
            kind: row.kind,
            expiresAt: row.expiresAt,
            reasonCode: row.reasonCode ?? null,
          }
        : null,
      nextStep: recipient.sharingFrozen
        ? 'Sharing is blocked. Request or await independent staff verification.'
        : 'Sharing is limited to the approved scopes until expiry.',
    };
  }
  async requestConsent(a: Actor, key: string, id: string, body: z.infer<typeof C.consentRequest>) {
    this.customer(a);
    return this.operation(a, key, 'consent-request:' + id, body, async (session) => {
      const recipient = await this.recipient(a, id, session);
      this.steward(a, recipient);
      if (
        body.noticeVersion !== this.settings.noticeVersion ||
        !body.requestedScopes.includes('RECIPIENT_DETAILS')
      )
        throw new DomainError('NOTICE_OR_SCOPE_MISMATCH', 422);
      if (
        recipient.state === 'ACTIVE' &&
        !recipient.sharingFrozen &&
        recipient.consentExpiresAt?.getTime() > this.now()
      )
        throw new DomainError('INVALID_TRANSITION', 422);
      await this.rate(a, 'consent-request', session);
      await (
        await this.collection('assisted_consent_cases')
      ).updateMany(
        { recipientId: id, stewardId: a.user.id, open: true, expiresAt: { $lte: this.date() } },
        {
          $set: { open: false, expiredAt: this.date(), updatedAt: this.date() },
          $inc: { version: 1 },
        },
        { session },
      );
      if (
        await (
          await this.collection('assisted_consent_cases')
        ).findOne({ recipientId: id, open: true }, { session })
      )
        throw new DomainError('OPEN_CASE_EXISTS', 409);
      const updated = await this.freeze(
        a,
        recipient,
        body.version,
        { state: 'PENDING_CONSENT' },
        session,
      );
      const row = this.row({
        recipientId: id,
        stewardId: a.user.id,
        kind: 'ACTIVATION',
        state: 'REQUESTED',
        open: true,
        assignedReviewerId: null,
        secondApproverId: null,
        requestedScopes: body.requestedScopes,
        consentScopes: [],
        noticeVersion: body.noticeVersion,
        independentConsentPossible: body.independentConsentPossible,
        contactAttempts: 0,
        expiresAt: new Date(this.now() + this.settings.caseDays * 86400000),
      });
      row.contactSealed = this.settings.seal(
        {
          phone: body.contactPhone,
          window: body.contactWindow,
          language: body.preferredLanguage,
          communicationNeeds: body.communicationNeeds,
        },
        'case:' + row._id + ':contact',
      );
      await (await this.collection('assisted_consent_cases')).insertOne(row, { session });
      await this.audit(a, 'CONSENT_REQUESTED', id, session, row._id);
      return {
        id: row._id,
        version: row.version,
        state: row.state,
        recipientVersion: updated.version,
      };
    });
  }
  async requestWithdrawal(
    a: Actor,
    key: string,
    id: string,
    body: z.infer<typeof C.withdrawalRequest>,
  ) {
    this.customer(a);
    return this.operation(a, key, 'withdrawal-request:' + id, body, async (session) => {
      const recipient = await this.recipient(a, id, session);
      this.steward(a, recipient);
      await this.rate(a, 'withdrawal-request', session);
      const cases = await this.collection('assisted_consent_cases');
      const previous = await cases
        .find({ recipientId: id, stewardId: a.user.id }, { session })
        .sort({ createdAt: -1 })
        .limit(1)
        .next();
      if (!previous) throw new DomainError('CONTACT_REVIEW_REQUIRED', 422);
      await cases.updateMany(
        { recipientId: id, open: true },
        { $set: { state: 'CANCELLED', open: false, updatedAt: this.date() }, $inc: { version: 1 } },
        { session },
      );
      const updated = await this.freeze(
        a,
        recipient,
        body.version,
        { withdrawalPending: true },
        session,
      );
      const row = this.row({
        recipientId: id,
        stewardId: a.user.id,
        kind: 'WITHDRAWAL',
        state: 'REQUESTED',
        open: true,
        assignedReviewerId: null,
        secondApproverId: null,
        requestedScopes: [],
        consentScopes: [],
        noticeVersion: this.settings.noticeVersion,
        contactAttempts: 0,
        reasonCode: body.reasonCode,
        expiresAt: new Date(this.now() + this.settings.caseDays * 86400000),
      });
      row.contactSealed = this.settings.seal(
        this.settings.unseal(previous.contactSealed, 'case:' + previous._id + ':contact'),
        'case:' + row._id + ':contact',
      );
      await cases.insertOne(row, { session });
      await this.audit(a, 'WITHDRAWAL_REVIEW_REQUESTED', id, session, row._id);
      return {
        id: row._id,
        version: row.version,
        state: row.state,
        sharingFrozen: true,
        recipientVersion: updated.version,
      };
    });
  }
  async circle(a: Actor, id: string, q: unknown) {
    const row = await this.recipient(a, id);
    return this.page(
      'care_circle_memberships',
      { recipientId: id, ...(row.stewardId === a.user.id ? {} : { identityId: a.user.id }) },
      q,
      (member) => ({
        id: member._id,
        version: member.version,
        role: member.role,
        scopes: member.scopes,
        status: member.status,
        identityLabel:
          member.identityId === a.user.id ? 'You' : (member.maskedPhone ?? 'Verified customer'),
      }),
    );
  }
  async invitations(a: Actor, id: string, q: unknown) {
    const row = await this.recipient(a, id);
    this.steward(a, row);
    return this.page('care_circle_invitations', { recipientId: id }, q, (v) => ({
      id: v._id,
      version: v.version,
      role: v.role,
      scopes: v.scopes,
      maskedPhone: v.maskedPhone,
      status: v.status,
      expiresAt: v.expiresAt,
    }));
  }
  async invite(a: Actor, key: string, id: string, body: z.infer<typeof C.invitationSchema>) {
    this.customer(a);
    const authorized = await this.recipient(a, id);
    this.steward(a, authorized);
    this.active(authorized);
    return this.operation(a, key, 'invitation:' + id, body, async (session) => {
      const recipient = await this.recipient(a, id, session);
      this.steward(a, recipient);
      this.active(recipient);
      if (
        !body.scopes.includes('RECIPIENT_DETAILS') ||
        body.scopes.some((scope) => !recipient.consentScopes.includes(scope))
      )
        throw new DomainError('FIELD_SCOPE_REQUIRED', 403);
      await this.rate(a, 'invitation', session);
      await this.change('care_recipients', recipient, body.version, {}, session);
      const identity = await (
        await this.collection('identities')
      ).findOne({ phone: body.phone, status: 'ACTIVE' }, { session });
      const membership = identity
        ? await (
            await this.collection('role_memberships')
          ).findOne({ identityId: identity._id, role: 'CUSTOMER', status: 'ACTIVE' }, { session })
        : null;
      const token = randomBytes(32).toString('base64url'),
        row = this.row({
          recipientId: id,
          stewardId: a.user.id,
          intendedIdentityId: membership && identity ? identity._id : null,
          role: body.role,
          scopes: body.scopes,
          maskedPhone: maskPhone(body.phone),
          status: 'PENDING',
          expiresAt: new Date(this.now() + 7 * 86400000),
          tokenDigest: this.settings.digest(token),
        });
      await (await this.collection('care_circle_invitations')).insertOne(row, { session });
      await (
        await this.collection('care_circle_invitation_artifacts')
      ).insertOne(this.row({ invitationId: row._id, expiresAt: row.expiresAt }), { session });
      await this.audit(a, 'INVITATION_CREATED', id, session);
      return {
        id: row._id,
        version: row.version,
        token,
        status: 'PENDING',
        message: 'Share this one-time code privately with the intended verified customer.',
        recipientVersion: body.version + 1,
      };
    });
  }
  async accept(a: Actor, key: string, token: string) {
    this.customer(a);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError('INVALID_INVITATION', 400);
    const digest = this.settings.digest(token);
    const check = async (session?: ClientSession) => {
      const row = await (
        await this.collection('care_circle_invitations')
      ).findOne({ tokenDigest: digest, intendedIdentityId: a.user.id }, session ? { session } : {});
      if (!row) throw new DomainError('INVITATION_UNAVAILABLE', 403);
      if (row.expiresAt.getTime() <= this.now()) throw new DomainError('INVITATION_EXPIRED', 410);
      const recipient = await (
        await this.collection('care_recipients')
      ).findOne(
        {
          _id: row.recipientId,
          state: 'ACTIVE',
          sharingFrozen: false,
          consentExpiresAt: { $gt: this.date() },
        },
        session ? { session } : {},
      );
      if (!recipient) throw new DomainError('CONSENT_REQUIRED', 422);
      return { row, recipient };
    };
    await check();
    return this.operation(a, key, 'accept', { digest }, async (session) => {
      const { row, recipient } = await check(session);
      if (row.status !== 'PENDING') throw new DomainError('INVITATION_USED_OR_REVOKED', 409);
      if (row.scopes.some((scope: string) => !recipient.consentScopes.includes(scope)))
        throw new DomainError('CONSENT_REQUIRED', 422);
      const members = await this.collection('care_circle_memberships'),
        old = await members.findOne(
          { recipientId: recipient._id, identityId: a.user.id },
          { session },
        );
      if (old?.status === 'ACTIVE') throw new DomainError('ALREADY_MEMBER', 409);
      const member = old
        ? await this.change(
            'care_circle_memberships',
            old,
            old.version,
            {
              role: row.role,
              scopes: row.scopes,
              status: 'ACTIVE',
              maskedPhone: a.user.maskedPhone,
            },
            session,
          )
        : this.row({
            recipientId: recipient._id,
            identityId: a.user.id,
            role: row.role,
            scopes: row.scopes,
            status: 'ACTIVE',
            maskedPhone: a.user.maskedPhone,
          });
      if (!old) await members.insertOne(member, { session });
      await this.change(
        'care_recipients',
        recipient,
        recipient.version,
        {
          sharedWith: [
            ...recipient.sharedWith,
            { identityId: a.user.id, role: row.role, scopes: row.scopes },
          ],
        },
        session,
      );
      await this.change(
        'care_circle_invitations',
        row,
        row.version,
        { status: 'ACCEPTED', acceptedAt: this.date() },
        session,
      );
      await this.audit(a, 'INVITATION_ACCEPTED', recipient._id, session);
      return { recipientId: recipient._id, role: row.role, scopes: row.scopes };
    });
  }
  async revoke(
    a: Actor,
    key: string,
    id: string,
    memberId: string,
    body: z.infer<typeof C.versionSchema>,
    invitation = false,
  ) {
    this.customer(a);
    return this.operation(a, key, 'revoke:' + id + ':' + memberId, body, async (session) => {
      const recipient = await this.recipient(a, id, session);
      this.steward(a, recipient);
      const name = invitation ? 'care_circle_invitations' : 'care_circle_memberships',
        row = await (
          await this.collection(name)
        ).findOne({ _id: memberId, recipientId: id }, { session });
      if (!row) throw new DomainError('NOT_FOUND', 404);
      if (row.role === 'STEWARD') throw new DomainError('FORBIDDEN', 403);
      await this.change(name, row, body.version, { status: 'REVOKED' }, session);
      await this.change(
        'care_recipients',
        recipient,
        recipient.version,
        {
          sharedWith: recipient.sharedWith.filter((v: Document) => v.identityId !== row.identityId),
        },
        session,
      );
      await this.audit(a, invitation ? 'INVITATION_REVOKED' : 'MEMBER_REVOKED', id, session);
      return { id: row._id, status: 'REVOKED', version: body.version + 1 };
    });
  }
  async activity(a: Actor, q: unknown) {
    this.customer(a);
    const visible = await (
      await this.collection('care_recipients')
    )
      .find({ $and: [{ state: { $ne: 'ARCHIVED' } }, this.sharingFilter(a)] })
      .project({ _id: 1 })
      .toArray();
    return this.page(
      'privacy_audit_events',
      { $or: [{ actorId: a.user.id }, { resourceId: { $in: visible.map((v) => v._id) } }] },
      q,
      (row) => ({
        id: row._id,
        action: row.action,
        resourceId: row.resourceId,
        createdAt: row.createdAt,
      }),
    );
  }
}
