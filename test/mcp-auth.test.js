import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { AuthFlow } from '../src/mcp-auth.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('split auth returns a code first, resumes polling, and never exposes tokens', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'oauth.json');
  let time = Date.now(), codeCalls = 0, polls = 0;
  const flow = new AuthFlow({ tokenPath, now: () => time, sleep: async (ms) => { time += ms; }, fetchImpl: async (url) => {
    if (url.endsWith('/device/code')) {
      codeCalls++;
      return json({ device_code: 'private-device-code', user_code: 'ABCD', verification_url: 'https://ya.ru/device', expires_in: 60, interval: 5 });
    }
    if (url.endsWith('/account/status')) return json({ result: { account: { uid: 123, login: 'example' } } });
    polls++;
    return polls < 3 ? json({ error: 'authorization_pending' }, 400) : json({ access_token: 'private-token', refresh_token: 'private-refresh', expires_in: 3600 });
  } });
  const first = await flow.init();
  assert.equal(first.user_code, 'ABCD');
  assert.equal((await flow.init()).auth_id, first.auth_id);
  assert.equal(codeCalls, 1);
  assert.equal((await flow.complete(first.auth_id, 0)).status, 'pending');
  assert.equal((await flow.complete(first.auth_id, 0)).status, 'pending');
  assert.equal(polls, 1, 'back-to-back requests do not exceed OAuth polling interval');
  const completed = await flow.complete(first.auth_id, 20);
  assert.equal(completed.status, 'authenticated');
  assert.equal(completed.account.uid, '123');
  assert.equal((await flow.complete(first.auth_id, 0)).status, 'authenticated');
  assert.equal(JSON.stringify([first, completed]).includes('private-'), false);
  const saved = JSON.parse(await readFile(tokenPath, 'utf8'));
  assert.equal(saved.access_token, 'private-token');
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
});

test('expired auth is reported without polling and unknown IDs fail', async () => {
  let time = Date.now();
  const flow = new AuthFlow({ tokenPath: 'unused', now: () => time, fetchImpl: async () => json({ device_code: 'private', user_code: 'ABCD', verification_url: 'https://ya.ru/device', expires_in: 1, interval: 5 }) });
  const code = await flow.init();
  time += 2000;
  assert.equal((await flow.complete(code.auth_id)).status, 'expired');
  await assert.rejects(flow.complete('unknown'), /Unknown/);
});

test('OAuth slow_down extends polling intervals and denied login does not save a token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, 'oauth.json');
  let time = Date.now(), polls = 0;
  const delays = [];
  const flow = new AuthFlow({ tokenPath, now: () => time, sleep: async (ms) => { delays.push(ms); time += ms; }, fetchImpl: async (url) => {
    if (url.endsWith('/device/code')) return json({ device_code: 'private', user_code: 'ABCD', verification_url: 'https://ya.ru/device', expires_in: 60, interval: 5 });
    return json({ error: ++polls === 1 ? 'slow_down' : 'access_denied' }, 400);
  } });
  const code = await flow.init();
  await assert.rejects(flow.complete(code.auth_id, 20), /access_denied/);
  assert.deepEqual(delays, [10000]);
  assert.equal((await flow.complete(code.auth_id)).status, 'failed');
  await assert.rejects(readFile(tokenPath), { code: 'ENOENT' });
});
