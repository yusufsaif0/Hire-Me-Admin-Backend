const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { MongoClient } = require('mongodb');
require('dotenv/config');
const marker = randomUUID().replaceAll('-', '');
const dbName = `hire_me_gate_${marker}`;
const redisKey = `hire_me:gate:${marker}`;
const env = {
  ...process.env,
  MONGO_PORT: process.env.MONGO_PORT ?? '27018',
  REDIS_PORT: process.env.REDIS_PORT ?? '6380',
};
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const compose = (args) =>
  execFileSync(docker, ['compose', ...args], { env, windowsHide: true, encoding: 'utf8' });
const client = new MongoClient(
  `mongodb://127.0.0.1:${env.MONGO_PORT}/?replicaSet=rs0&directConnection=true`,
  { serverSelectionTimeoutMS: 2000 },
);
async function retry(fn) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('Infrastructure did not recover within 45 seconds');
}
(async () => {
  if (!/^hire_me_gate_[a-f0-9]{32}$/.test(dbName)) throw new Error('Refusing unsafe test cleanup');
  try {
    await client.connect();
    const db = client.db(dbName);
    const hello = await db.admin().command({ hello: 1 });
    assert.equal(hello.setName, 'rs0');
    assert.equal(hello.isWritablePrimary, true);
    await db.createCollection('probe');
    await client.withSession(async (session) =>
      session.withTransaction(async () => {
        await db.collection('probe').insertOne({ marker }, { session });
      }),
    );
    assert.equal(
      compose(['exec', '-T', 'redis', 'redis-cli', 'SET', redisKey, marker]).trim(),
      'OK',
    );
    compose(['restart', 'mongo', 'redis']);
    await retry(async () => {
      assert.equal((await db.admin().command({ hello: 1 })).isWritablePrimary, true);
      assert.equal((await db.collection('probe').findOne({ marker }))?.marker, marker);
    });
    await retry(async () =>
      assert.equal(compose(['exec', '-T', 'redis', 'redis-cli', 'GET', redisKey]).trim(), marker),
    );
    console.log(
      'PASS: MongoDB replica set, transaction, volume persistence/reconnection and Redis persistence after restart.',
    );
  } finally {
    await client
      .db(dbName)
      .dropDatabase()
      .catch(() => {});
    await client.close();
    compose(['exec', '-T', 'redis', 'redis-cli', 'DEL', redisKey]);
  }
})().catch(() => {
  console.error('Infrastructure gate failed; persistence verification remains blocked.');
  process.exitCode = 1;
});
