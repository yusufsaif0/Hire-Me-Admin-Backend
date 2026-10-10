export const backendRole = 'ADMIN' as const;
import { parseEnvironment } from './config/environment';
export const serviceId = 'trusted-assistance-admin-api' as const;
export function parseBackendEnvironment(input: Record<string, unknown>) {
  return parseEnvironment({ PORT: 4000, CORS_ORIGIN: 'http://localhost:3000', ...input });
}
