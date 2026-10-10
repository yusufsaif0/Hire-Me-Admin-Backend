require('dotenv/config');
const { MongoClient } = require('mongodb');
const { parseBackendEnvironment } = require('../dist/environment');
const { migrate } = require('./migrations/0002-family.cjs');
(async () => {
  const env = parseBackendEnvironment(process.env);
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await migrate(client, env.MONGODB_DB_NAME);
    console.log(`Family migration 0002 applied to ${env.MONGODB_DB_NAME}. No accounts seeded.`);
  } finally {
    await client.close();
  }
})().catch(() => {
  console.error(
    'Phase 2 migration failed; check migration 0001 and database access. No credentials printed.',
  );
  process.exitCode = 1;
});
