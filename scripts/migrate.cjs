require('dotenv/config');
const { MongoClient } = require('mongodb');
const { parseBackendEnvironment } = require('../dist/environment');
const { migrate } = require('./migrations/0001-identity.cjs');
(async () => {
  const env = parseBackendEnvironment(process.env);
  const client = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await migrate(client, env.MONGODB_DB_NAME);
    console.log(`Identity migration 0001 applied to ${env.MONGODB_DB_NAME}.`);
  } finally {
    await client.close();
  }
})().catch(() => {
  console.error(
    'Migration failed. Check database access and replica-set readiness; credentials were not printed.',
  );
  process.exitCode = 1;
});
