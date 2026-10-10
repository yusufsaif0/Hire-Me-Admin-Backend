const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '../../..');
const projects = ['admin-panel', 'customer-app', 'worker-app'];
const adminFile = path.join(root, 'admin-panel/backend/.env');
const initial = dotenv.parse(fs.readFileSync(adminFile));
const digest = initial.AUTH_DIGEST_KEY ?? randomBytes(32).toString('hex');
for (const project of projects) {
  const filename = path.join(root, project, 'backend/.env');
  const original = fs.readFileSync(filename, 'utf8');
  const current = dotenv.parse(original);
  const keys =
    current.AUTH_PRIVATE_KEY && current.AUTH_PUBLIC_KEY
      ? null
      : generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
  const values = {
    AUTH_ENABLED: 'true',
    AUTH_DIGEST_KEY: current.AUTH_DIGEST_KEY ?? digest,
    AUTH_ENCRYPTION_KEY: current.AUTH_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'),
    AUTH_PRIVATE_KEY: current.AUTH_PRIVATE_KEY ?? Buffer.from(keys.privateKey).toString('base64'),
    AUTH_PUBLIC_KEY: current.AUTH_PUBLIC_KEY ?? Buffer.from(keys.publicKey).toString('base64'),
  };
  const existing = original
    .split(/\r?\n/)
    .filter((line) => !Object.keys(values).some((key) => line.startsWith(`${key}=`)))
    .join('\n')
    .trimEnd();
  fs.writeFileSync(
    filename,
    `${existing}\n${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
}
console.log(
  'Independent authentication keys generated/preserved in the three ignored backend .env files. No credentials printed.',
);
