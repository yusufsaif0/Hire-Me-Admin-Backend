import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { familyResponse } from './family/responses';
export function createOpenApi(app: INestApplication) {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Trusted Assistance Admin API')
      .setDescription(
        'Phase 2 family data and assisted consent; Phase 1 identity retained. Mock SMS only; no production startup. Health retains its Phase 0 liveness contract. Responses include an x-request-id UUID header.',
      )
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access')
      .addCookieAuth(
        'admin_access',
        { type: 'apiKey', in: 'cookie', name: 'admin_access' },
        'accessCookie',
      )
      .addCookieAuth(
        'admin_refresh',
        { type: 'apiKey', in: 'cookie', name: 'admin_refresh' },
        'refresh',
      )
      .setVersion('0.3.0')
      .build(),
  );
  for (const [path, item] of Object.entries(document.paths)) {
    const domain =
      path.startsWith('/v1/customer/') ||
      path.startsWith('/v1/admin/consent-cases') ||
      path.startsWith('/v1/admin/support/');
    if (!domain && !path.includes('/auth/')) continue;
    for (const method of ['get', 'post', 'patch', 'delete'] as const) {
      const operation = item[method];
      if (!operation) continue;
      if (domain) {
        const schema = familyResponse(path, method);
        if (schema) {
          const success = Object.keys(operation.responses).find((code) => /^2/.test(code)) ?? '200';
          operation.responses[success] = {
            description: 'Authorized Phase 2 response; sensitive fields are scoped and redacted.',
            headers: { 'X-Request-ID': { schema: { type: 'string', format: 'uuid' } } },
            content: { 'application/json': { schema } },
          };
        }
        if (method !== 'get' && path.startsWith('/v1/admin/'))
          operation.parameters = [
            ...(operation.parameters ?? []),
            {
              name: 'X-CSRF-Token',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'Bound to the MFA-authenticated admin session. Origin is also checked.',
            },
          ];
        if (method === 'get' && path.endsWith('/consent-cases'))
          operation.parameters = [
            ...(operation.parameters ?? []),
            { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
          ];
        if (
          method === 'get' &&
          /\/(addresses|recipients|emergency-contacts|invitations|care-circle|activity|consent-cases)$/.test(
            path,
          )
        )
          operation.parameters = [
            ...(operation.parameters ?? []),
            {
              name: 'cursor',
              in: 'query',
              required: false,
              schema: { type: 'string', maxLength: 250 },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            },
          ];
      }
      for (const status of domain
        ? [400, 401, 403, 404, 409, 410, 422, 429, 503]
        : [400, 401, 403, 429, 503]) {
        operation.responses[status] = {
          description: domain
            ? 'Correlated, redacted Phase 2 input, permission, consent, concurrency or dependency error. See PHASE_2_SPEC.md.'
            : status === 429
              ? 'Rate limited; retry after the indicated seconds.'
              : 'Correlated, redacted authentication error. See IDENTITY_API.md for codes.',
          headers: {
            'X-Request-ID': { schema: { type: 'string', format: 'uuid' } },
            ...(!domain && status === 429
              ? { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } }
              : {}),
          },
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['statusCode', 'code', 'message', 'requestId'],
                properties: {
                  statusCode: { type: 'integer' },
                  code: { type: 'string' },
                  message: { type: 'string' },
                  requestId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        };
      }
    }
  }
  return document;
}
export function configureOpenApi(app: INestApplication): void {
  SwaggerModule.setup('docs', app, createOpenApi(app));
}
