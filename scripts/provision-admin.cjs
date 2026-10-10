require('dotenv/config');
const { createInterface } = require('node:readline/promises');
const { Writable } = require('node:stream');
const { AuthSettings } = require('../dist/auth/settings');
const { AuthRepository } = require('../dist/auth/repository');
const { AuthService } = require('../dist/auth/service');
const { MockSms } = require('../dist/auth/mock-sms');
const { base32 } = require('../dist/auth/crypto');
(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Provisioning requires a private interactive terminal');
  let hidden = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const settings = new AuthSettings('ADMIN');
  const repo = new AuthRepository(settings);
  try {
    const phone = await reader.question('Admin phone in E.164 form: ');
    process.stdout.write('Password (16–128 characters; input hidden): ');
    hidden = true;
    const password = await reader.question('');
    hidden = false;
    process.stdout.write('\n');
    const auth = new AuthService(settings, repo, new MockSms(settings));
    const seed = await auth.provisionAdmin(phone, password);
    console.log(
      'Admin provisioned. Enroll this secret in your authenticator now. This is shown only in this interactive provisioning terminal:',
    );
    console.log(
      `otpauth://totp/Trusted%20Assistance:Admin?secret=${base32(seed)}&issuer=Trusted%20Assistance&algorithm=SHA1&digits=6&period=30`,
    );
    console.log('No default admin password or public registration route exists.');
  } finally {
    reader.close();
    await repo.onModuleDestroy();
  }
})().catch(() => {
  console.error(
    'Admin provisioning failed. Check migration, phone uniqueness, password length and local development configuration.',
  );
  process.exitCode = 1;
});
