import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { writeState } from './state.js';

export const defaultTokenPath = fileURLToPath(new URL('../.ya/oauth.json', import.meta.url));
const oauthOrigin = 'https://oauth.yandex.ru';
const accountUrl = 'https://api.music.yandex.net/account/status';

// Public Android client credentials used by the unofficial yandex-music-api.
// https://github.com/MarshalX/yandex-music-api/blob/main/yandex_music/_client/device_auth.py
const clientId = '23cabbbdc6cd418abb4b39c32c41195d';
const clientSecret = '53bc75238f0c4d08a118e51fe9203300';

async function oauthRequest(path, data, fetchImpl) {
  const response = await fetchImpl(`${oauthOrigin}/${path}`, {
    method: 'POST',
    body: new URLSearchParams(data),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`OAuth: response is not JSON (HTTP ${response.status}).`); }
  if (!response.ok && !result.error) throw new Error(`OAuth: HTTP ${response.status}.`);
  return result;
}

function assertToken(result) {
  if (result.error) throw new Error(`OAuth: ${result.error}.`);
  if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('OAuth did not return an access token.');
  return result;
}

export async function requestDeviceCode(fetchImpl = globalThis.fetch) {
  const code = await oauthRequest('device/code', {
    client_id: clientId,
    device_id: randomBytes(10).toString('hex'),
    device_name: 'YaMusicUploader',
  }, fetchImpl);
  if (code.error) throw new Error(`OAuth: ${code.error}.`);
  if (!code.device_code || !code.user_code || !code.verification_url || !(Number(code.expires_in) > 0)) {
    throw new Error('OAuth returned an incomplete device/code response.');
  }
  return code;
}

export async function pollDeviceToken(deviceCode, fetchImpl = globalThis.fetch) {
  const result = await oauthRequest('token', {
    grant_type: 'device_code', code: deviceCode,
    client_id: clientId, client_secret: clientSecret,
  }, fetchImpl);
  if (!result.error) return { status: 'authorized', token: assertToken(result) };
  if (['authorization_pending', 'slow_down'].includes(result.error)) return { status: result.error };
  throw new Error(`OAuth: ${result.error}.`);
}

export async function verifyMusicToken(token, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(accountUrl, {
    headers: { authorization: `OAuth ${token.access_token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Music API token verification: HTTP ${response.status}.`);
  const data = await response.json();
  const account = data.result?.account;
  if (!account?.uid) throw new Error('The Music API did not confirm the account UID.');
  return account;
}

export async function saveToken(token, tokenPath, account) {
  const expiresIn = Number(token.expires_in);
  await writeState({
    ...token,
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
    uid: String(account.uid), obtained_at: new Date().toISOString(),
  }, tokenPath);
}

export async function loadToken(tokenPath) {
  let token;
  try { token = JSON.parse(await readFile(tokenPath, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No OAuth token found. Use init_auth to sign in.');
    throw error;
  }
  return assertToken(token);
}

export async function refreshToken(token, fetchImpl = globalThis.fetch) {
  if (!token.refresh_token) throw new Error('No refresh token available. Use init_auth to sign in again.');
  const refreshed = assertToken(await oauthRequest('token', {
    grant_type: 'refresh_token', refresh_token: token.refresh_token,
    client_id: clientId, client_secret: clientSecret,
  }, fetchImpl));
  return { ...refreshed, refresh_token: refreshed.refresh_token ?? token.refresh_token };
}

// https://yandex.ru/dev/id/doc/ru/tokens/token-invalidate
export async function revokeToken(token, fetchImpl = globalThis.fetch) {
  const result = await oauthRequest('revoke_token', {
    access_token: token.access_token, client_id: clientId, client_secret: clientSecret,
  }, fetchImpl);
  if (result.error || result.status !== 'ok') throw new Error('Yandex did not confirm token revocation.');
}
