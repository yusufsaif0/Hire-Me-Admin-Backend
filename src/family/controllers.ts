import {
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Req,
  HttpCode,
  UseGuards,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  applyDecorators,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiBody,
  ApiHeader,
  ApiResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { z } from 'zod';
import { AccessGuard, type AuthRequest, validate } from '../auth/http';
import { AuthService } from '../auth/service';
import { CustomerFamilyService } from './customer-service';
import { ConsentAdminService } from './admin-service';
import { DomainError } from './settings';
import * as C from './contracts';
const id = (value: string) => validate(z.uuid(), value);
const actor = (request: AuthRequest) => {
  if (!request.authenticated) throw new DomainError('INVALID_SESSION', 401);
  return request.authenticated;
};
const key = (request: AuthRequest) => request.header('idempotency-key') ?? '';
function Input(schema: z.ZodType) {
  return applyDecorators(
    ApiBody({ schema: z.toJSONSchema(schema, { target: 'openapi-3.0' }) as SchemaObject }),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: 'UUID for a logical mutation; reuse only for identical retries.',
    }),
    ApiResponse({ status: 409, description: 'Version, duplicate or idempotency conflict.' }),
    ApiResponse({ status: 422, description: 'Consent/state transition not permitted.' }),
  );
}
@Injectable()
export class ConsentCsrfGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    if (req.method !== 'GET') {
      if (req.header('origin') !== new URL(this.auth.settings.env.CORS_ORIGIN).origin)
        throw new DomainError('FORBIDDEN', 403);
      this.auth.csrf(actor(req).session, req.header('x-csrf-token') ?? '');
    }
    return true;
  }
}
@ApiTags('Customer profiles and family')
@ApiBearerAuth('access')
@UseGuards(AccessGuard)
@Controller('customer')
export class CustomerFamilyController {
  constructor(private readonly family: CustomerFamilyService) {}
  @Get('profile') @ApiOperation({ summary: 'Read own profile and masked verified phone' }) profile(
    @Req() r: AuthRequest,
  ) {
    return this.family.profile(actor(r));
  }
  @Patch('profile') @Input(C.profileSchema) saveProfile(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.family.saveProfile(actor(r), key(r), validate(C.profileSchema, b));
  }
  @Get('consent-policy') async policy(@Req() r: AuthRequest) {
    this.family.customer(actor(r));
    await this.family.ready();
    return this.family.policy();
  }
  @Get('addresses') addresses(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.family.addresses(actor(r), validate(C.listSchema, q));
  }
  @Post('addresses') @Input(C.addressSchema) createAddress(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.family.writeAddress(actor(r), key(r), null, validate(C.addressSchema, b));
  }
  @Get('addresses/:id') address(@Req() r: AuthRequest, @Param('id') v: string) {
    return this.family.address(actor(r), id(v));
  }
  @Patch('addresses/:id') @Input(C.addressPatch) patchAddress(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.family.writeAddress(actor(r), key(r), id(v), validate(C.addressPatch, b));
  }
  @Delete('addresses/:id') @Input(C.versionSchema) deleteAddress(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.family.writeAddress(actor(r), key(r), id(v), validate(C.versionSchema, b), true);
  }
  @Get('recipients') recipients(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.family.recipients(actor(r), validate(C.listSchema, q));
  }
  @Post('recipients') @Input(C.recipientSchema) createRecipient(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.family.writeRecipient(actor(r), key(r), null, validate(C.recipientSchema, b));
  }
  @Get('recipients/:id') recipient(@Req() r: AuthRequest, @Param('id') v: string) {
    return this.family.recipientDetail(actor(r), id(v));
  }
  @Patch('recipients/:id') @Input(C.recipientPatch) patchRecipient(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.family.writeRecipient(actor(r), key(r), id(v), validate(C.recipientPatch, b));
  }
  @Delete('recipients/:id') @Input(C.versionSchema) archiveRecipient(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.family.writeRecipient(actor(r), key(r), id(v), validate(C.versionSchema, b), true);
  }
  @Get('recipients/:id/emergency-contacts') contacts(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Query() q: unknown,
  ) {
    return this.family.contacts(actor(r), id(v), validate(C.listSchema, q));
  }
  @Post('recipients/:id/emergency-contacts') @Input(C.contactSchema) createContact(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.family.writeContact(actor(r), key(r), id(v), null, validate(C.contactSchema, b));
  }
  @Patch('recipients/:id/emergency-contacts/:contactId') @Input(C.contactPatch) patchContact(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Param('contactId') c: string,
    @Body() b: unknown,
  ) {
    return this.family.writeContact(actor(r), key(r), id(v), id(c), validate(C.contactPatch, b));
  }
  @Delete('recipients/:id/emergency-contacts/:contactId') @Input(C.versionSchema) deleteContact(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Param('contactId') c: string,
    @Body() b: unknown,
  ) {
    return this.family.writeContact(
      actor(r),
      key(r),
      id(v),
      id(c),
      validate(C.versionSchema, b),
      true,
    );
  }
  @Get('recipients/:id/consent') consent(@Req() r: AuthRequest, @Param('id') v: string) {
    return this.family.consent(actor(r), id(v));
  }
  @Get('recipients/:id/assisted-consent-status') status(
    @Req() r: AuthRequest,
    @Param('id') v: string,
  ) {
    return this.family.consent(actor(r), id(v));
  }
  @Post('recipients/:id/consent-requests') @HttpCode(202) @Input(C.consentRequest) requestConsent(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.family.requestConsent(actor(r), key(r), id(v), validate(C.consentRequest, b));
  }
  @Post('recipients/:id/assisted-consent-requests')
  @HttpCode(202)
  @Input(C.consentRequest)
  assisted(@Req() r: AuthRequest, @Param('id') v: string, @Body() b: unknown) {
    return this.family.requestConsent(actor(r), key(r), id(v), validate(C.consentRequest, b));
  }
  @Post('recipients/:id/consent-withdrawal-requests')
  @HttpCode(202)
  @Input(C.withdrawalRequest)
  requestWithdrawal(@Req() r: AuthRequest, @Param('id') v: string, @Body() b: unknown) {
    return this.family.requestWithdrawal(actor(r), key(r), id(v), validate(C.withdrawalRequest, b));
  }
  @Post('recipients/:id/consent-withdrawal')
  @HttpCode(422)
  @ApiOperation({
    summary: 'Reject direct family attestation; use an independently reviewed withdrawal request',
  })
  async withdraw(@Req() r: AuthRequest, @Param('id') v: string) {
    const row = await this.family.recipient(actor(r), id(v));
    this.family.steward(actor(r), row);
    throw new DomainError('INDEPENDENT_WITHDRAWAL_REQUIRED', 422);
  }
  @Get('recipients/:id/care-circle') circle(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Query() q: unknown,
  ) {
    return this.family.circle(actor(r), id(v), validate(C.listSchema, q));
  }
  @Get('recipients/:id/care-circle/invitations') invitations(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Query() q: unknown,
  ) {
    return this.family.invitations(actor(r), id(v), validate(C.listSchema, q));
  }
  @Post('recipients/:id/care-circle/invitations') @HttpCode(202) @Input(C.invitationSchema) invite(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.family.invite(actor(r), key(r), id(v), validate(C.invitationSchema, b));
  }
  @Post('care-circle/invitations/:token/accept') @HttpCode(200) @Input(C.acceptanceSchema) accept(
    @Req() r: AuthRequest,
    @Param('token') token: string,
    @Body() b: unknown,
  ) {
    validate(C.acceptanceSchema, b);
    return this.family.accept(actor(r), key(r), token);
  }
  @Delete('recipients/:id/care-circle/members/:memberId') @Input(C.versionSchema) revoke(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Param('memberId') m: string,
    @Body() b: unknown,
  ) {
    return this.family.revoke(actor(r), key(r), id(v), id(m), validate(C.versionSchema, b));
  }
  @Delete('recipients/:id/care-circle/invitations/:invitationId')
  @Input(C.versionSchema)
  revokeInvite(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Param('invitationId') m: string,
    @Body() b: unknown,
  ) {
    return this.family.revoke(actor(r), key(r), id(v), id(m), validate(C.versionSchema, b), true);
  }
  @Get('privacy/activity') activity(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.family.activity(actor(r), validate(C.listSchema, q));
  }
}
@ApiTags('Assisted consent review')
@ApiCookieAuth('accessCookie')
@UseGuards(AccessGuard, ConsentCsrfGuard)
@Controller('admin')
export class ConsentAdminController {
  constructor(private readonly consent: ConsentAdminService) {}
  @Get('support/recipients') support(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.consent.support(actor(r), validate(C.listSchema, q));
  }
  @Get('consent-cases') queue(@Req() r: AuthRequest, @Query() q: unknown) {
    return this.consent.queue(actor(r), validate(C.listSchema, q));
  }
  @Get('consent-cases/:id') detail(@Req() r: AuthRequest, @Param('id') v: string) {
    return this.consent.detail(actor(r), id(v));
  }
  @Post('consent-cases/:id/claim') @HttpCode(200) @Input(C.versionSchema) claim(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.consent.claim(actor(r), key(r), id(v), validate(C.versionSchema, b));
  }
  @Post('consent-cases/:id/contact-attempts') @HttpCode(200) @Input(C.contactAttemptSchema) contact(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.consent.contactAttempt(
      actor(r),
      key(r),
      id(v),
      validate(C.contactAttemptSchema, b),
    );
  }
  @Post('consent-cases/:id/evidence') @HttpCode(200) @Input(C.evidenceSchema) evidence(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.consent.evidence(actor(r), key(r), id(v), validate(C.evidenceSchema, b));
  }
  @Post('consent-cases/:id/submit-review') @HttpCode(200) @Input(C.versionSchema) submit(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.consent.submit(actor(r), key(r), id(v), validate(C.versionSchema, b));
  }
  @Post('consent-cases/:id/decision') @HttpCode(200) @Input(C.decisionSchema) decision(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.consent.decision(actor(r), key(r), id(v), validate(C.decisionSchema, b));
  }
  @Post('consent-cases/:id/withdrawal') @HttpCode(200) @Input(C.staffWithdrawal) withdrawal(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.consent.withdrawal(actor(r), key(r), id(v), validate(C.staffWithdrawal, b));
  }
  @Post('consent-cases/:id/withdrawal-intake') @HttpCode(200) @Input(C.withdrawalRequest) intake(
    @Req() r: AuthRequest,
    @Param('id') v: string,
    @Body() b: unknown,
  ) {
    return this.consent.withdrawalIntake(actor(r), key(r), id(v), validate(C.withdrawalRequest, b));
  }
}
