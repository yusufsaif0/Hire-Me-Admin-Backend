const fs = require('node:fs'),
  path = require('node:path'),
  { randomBytes } = require('node:crypto'),
  dotenv = require('dotenv');
try {
  const root = path.resolve(__dirname, '../../..');
  const files = ['admin-panel', 'customer-app'].map((project) =>
    path.join(root, project, 'backend', '.env'),
  );
  const inputs = files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
  const parsed = inputs.map((v) => dotenv.parse(v.text));
  const existing = parsed.map((v) => v.PHASE2_DATA_KEYS).filter(Boolean);
  if (
    existing.length > 1 &&
    JSON.stringify(JSON.parse(existing[0])) !== JSON.stringify(JSON.parse(existing[1]))
  )
    throw new Error('Phase 2 keyrings differ; reconcile privately before setup.');
  const ring = existing[0] ?? JSON.stringify({ v1: randomBytes(32).toString('hex') });
  for (let index = 0; index < inputs.length; index++) {
    const { file, text } = inputs[index],
      env = parsed[index],
      values = {
        PHASE2_ENABLED: 'true',
        PHASE2_DATA_KEYS: ring,
        PHASE2_ACTIVE_KEY_ID: env.PHASE2_ACTIVE_KEY_ID ?? 'v1',
        PHASE2_NOTICE_VERSION: env.PHASE2_NOTICE_VERSION ?? 'development-2026-10-10',
      };
    const original = text
      .split(/\r?\n/)
      .filter((line) => !Object.keys(values).some((key) => line.startsWith(key + '=')))
      .join('\n')
      .trimEnd();
    fs.writeFileSync(
      file,
      original +
        '\n' +
        Object.entries(values)
          .map(([k, v]) => k + '=' + v)
          .join('\n') +
        '\n',
      { mode: 0o600 },
    );
  }
  console.log(
    'Phase 2 keyring generated/preserved in ignored admin/customer settings. Authentication/database settings preserved. No secrets printed.',
  );
} catch {
  console.error(
    'Phase 2 setup failed; check private settings and keyring consistency. No secrets printed.',
  );
  process.exitCode = 1;
}
