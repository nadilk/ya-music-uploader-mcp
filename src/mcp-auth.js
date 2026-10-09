import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { pollDeviceToken, requestDeviceCode, saveToken, verifyMusicToken } from './device-auth.js';

export class AuthFlow {
  constructor({ tokenPath, fetchImpl = globalThis.fetch, now = Date.now, sleep = setTimeout }) {
    this.tokenPath = tokenPath;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.current = null;
    this.initializing = null;
  }

  describe(flow) {
    return {
      auth_id: flow.id, status: flow.status, verification_url: flow.code.verification_url,
      user_code: flow.code.user_code, expires_at: new Date(flow.expiresAt).toISOString(),
      poll_interval_seconds: flow.interval / 1000,
      ...(flow.account ? { account: { uid: String(flow.account.uid), login: flow.account.login } } : {}),
      next_step: flow.status === 'authenticated' ? 'Authentication complete.' : flow.status !== 'pending' ? 'Use init_auth to start a new login.' : 'Show the user the URL and code, then call complete_auth with auth_id. If pending, repeat complete_auth with the same auth_id.',
    };
  }

  reset() {
    this.current = null;
  }

  async init() {
    if (this.current?.status === 'pending' && this.current.expiresAt > this.now()) return this.describe(this.current);
    if (!this.initializing) {
      this.initializing = (async () => {
        const code = await requestDeviceCode(this.fetch);
        this.current = {
          id: randomUUID(), code, status: 'pending', interval: Math.max(1, Number(code.interval) || 5) * 1000,
          expiresAt: this.now() + Number(code.expires_in) * 1000, nextPollAt: this.now(), polling: false,
        };
        return this.describe(this.current);
      })().finally(() => { this.initializing = null; });
    }
    return this.initializing;
  }

  async complete(authId, waitSeconds = 20) {
    const flow = this.current;
    if (!flow || flow.id !== authId) throw new Error('Unknown auth_id. Call init_auth; pending authentication must restart after a server restart.');
    if (flow.status === 'authenticated') return this.describe(flow);
    if (flow.expiresAt <= this.now()) flow.status = 'expired';
    if (flow.status !== 'pending') return this.describe(flow);
    if (flow.polling) return this.describe(flow);
    flow.polling = true;
    const deadline = this.now() + Math.min(45, Math.max(0, waitSeconds)) * 1000;
    const boundedFetch = (url, options) => this.fetch(url, {
      ...options,
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(Math.ceil(Math.max(5000, deadline - this.now())))]),
    });
    try {
      while (this.now() < flow.expiresAt) {
        if (flow.nextPollAt > this.now()) {
          if (flow.nextPollAt > deadline) break;
          await this.sleep(flow.nextPollAt - this.now());
          if (this.now() >= flow.expiresAt) break;
        }
        const result = flow.authorizedToken ? { status: 'authorized', token: flow.authorizedToken } : await pollDeviceToken(flow.code.device_code, boundedFetch);
        if (result.status === 'authorized') {
          flow.authorizedToken = result.token;
          const account = await verifyMusicToken(result.token, boundedFetch);
          await saveToken(result.token, this.tokenPath, account);
          flow.status = 'authenticated';
          flow.account = account;
          delete flow.authorizedToken;
          return this.describe(flow);
        }
        if (result.status === 'slow_down') flow.interval += 5000;
        flow.nextPollAt = this.now() + flow.interval;
        if (this.now() >= deadline) break;
      }
      if (flow.expiresAt <= this.now()) flow.status = 'expired';
      return this.describe(flow);
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name)) return this.describe(flow);
      if (/access_denied|expired_token|invalid_grant/.test(error.message)) flow.status = 'failed';
      throw error;
    } finally {
      flow.polling = false;
    }
  }
}
