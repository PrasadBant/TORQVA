import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError, READ_TIMEOUT_MS } from '../torqva/api.js';

// A fetch that never answers until its signal aborts (as a hung backend would behave).
const hangingFetch = () => vi.fn((url, o = {}) => new Promise((_, reject) => {
  o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('api client', () => {
  it('a read that gets no answer fails after the timeout instead of waiting forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', hangingFetch());
    const p = api.status();
    const settled = expect(p).rejects.toThrow(`did not answer within ${READ_TIMEOUT_MS / 1000} s`);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 1);
    await settled;
  });

  it('a command is never aborted by the client, so its outcome is not hidden', async () => {
    vi.useFakeTimers();
    const f = hangingFetch(); vi.stubGlobal('fetch', f);
    let done = false;
    api.deviceCommand({ action: 'STOP' }).then(() => { done = true; }, () => { done = true; });
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS * 3);
    expect(done).toBe(false);
    expect(f.mock.calls[0][1].signal).toBeUndefined();
  });

  it('reports the server detail and status for a rejected request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ detail: 'role operator required' }) })));
    const e = await api.status().catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(403);
    expect(e.message).toBe('role operator required');
  });
});
