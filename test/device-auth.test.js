import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollDeviceToken, requestDeviceCode, refreshToken, revokeToken, verifyMusicToken } from '../src/device-auth.js';

function json(value, status = 200) { return new Response(JSON.stringify(value), { status }); }

test('device flow uses Yandex grant parameters and returns pending without tokens', async () => {
  const code = await requestDeviceCode(async (url, options) => {
    assert.equal(url, 'https://oauth.yandex.ru/device/code');
    assert.ok(options.body.get('client_id'));
    return json({ device_code: 'private-code', user_code: 'ABCD', verification_url: 'https://ya.ru/device', expires_in: 60 });
  });
  const result = await pollDeviceToken(code.device_code, async (url, options) => {
    assert.equal(options.body.get('grant_type'), 'device_code');
    assert.equal(options.body.get('code'), 'private-code');
    return json({ error: 'authorization_pending' }, 400);
  });
  assert.deepEqual(result, { status: 'authorization_pending' });
  await assert.rejects(pollDeviceToken('private', async () => json({ error: 'access_denied' }, 400)), /access_denied/);
});

test('account check uses OAuth and rejects anonymous API responses', async () => {
  const account = await verifyMusicToken({ access_token: 'example' }, async (url, options) => {
    assert.equal(url, 'https://api.music.yandex.net/account/status');
    assert.equal(options.headers.authorization, 'OAuth example');
    return json({ result: { account: { uid: 123 } } });
  });
  assert.equal(account.uid, 123);
  await assert.rejects(verifyMusicToken({ access_token: 'example' }, async () => json({ result: {} })), /UID/);
});

test('refresh retains the old refresh token when the response does not rotate it', async () => {
  const token = await refreshToken({ refresh_token: 'refresh' }, async (url, options) => {
    assert.equal(options.body.get('grant_type'), 'refresh_token');
    assert.equal(options.body.get('refresh_token'), 'refresh');
    return json({ access_token: 'new', expires_in: 3600 });
  });
  assert.equal(token.refresh_token, 'refresh');
  assert.equal(token.access_token, 'new');
});

test('device token revocation posts credentials and requires explicit confirmation', async () => {
  await revokeToken({ access_token: 'private-token' }, async (url, options) => {
    assert.equal(url, 'https://oauth.yandex.ru/revoke_token');
    assert.equal(options.method, 'POST');
    assert.equal(options.body.get('access_token'), 'private-token');
    assert.ok(options.body.get('client_id'));
    assert.ok(options.body.get('client_secret'));
    assert.equal(options.redirect, 'error');
    return json({ status: 'ok' });
  });
  await assert.rejects(revokeToken({ access_token: 'private-token' }, async () => json({ error: 'unsupported_token_type' }, 400)), /revocation/);
  await assert.rejects(revokeToken({ access_token: 'private-token' }, async () => json({})), /revocation/);
});
