// PlatformModule over the shared StarHermit SDK: token, profile, cloud save,
// settings KV, bindings, invite link and the standalone no-network guarantee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PlatformModule } from '../platform.js';

const require = createRequire(import.meta.url);
const SDK = require('../starhermit-sdk.js');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = () => 'h.' + b64u({ sub: 'user-123456789', game_scope: 'gid-1', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

function backend() {
  const calls = [], saves = {}, settings = {};
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, auth: init.headers && init.headers.Authorization });
    const r = (st, b) => new Response(b, { status: st });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (method === 'PUT') { saves[key] = Buffer.from(body.dataBase64, 'base64'); return r(200, '{}'); }
      return saves[key] ? r(200, saves[key]) : r(404, '');
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'pk', nickname: 'Al' }));
    if (/\/settings$/.test(url)) {
      if (method === 'PATCH') Object.assign(settings, body.settings);
      return r(200, JSON.stringify({ settings }));
    }
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'throttle', codes: ['KeyI'] }] }));
    return r(404, '');
  };
  return { calls, saves, fetch };
}
function make(hash, fetch, hostname = 'localhost') {
  let replaced = null;
  const win = { location: { hash, search: '', pathname: '/', hostname, origin: 'https://' + hostname, href: '' }, history: { replaceState: (a, b, u) => { replaced = u; } } };
  const sdk = SDK.create({ window: win, fetch }).init();
  return { p: new PlatformModule({ sdk, fetchImpl: fetch }), sdk, replaced: () => replaced };
}

test('launch token: profile, cloud save game:<slug>, settings, bindings, invite', async () => {
  const be = backend();
  const { p, sdk, replaced } = make('#game_token=' + token(), be.fetch);
  assert.equal(p.hosted, true);
  assert.equal(p.gameScope, 'gid-1');
  assert.equal(p.userId, 'user-123456789');
  assert.equal(replaced(), '/');
  await p.loadProfile();
  assert.equal(p.nickname, 'Al');

  p.queueSave({ schemaVersion: 1, progress: { lastStage: 3 } });
  assert.equal(p.syncState, 'saving');
  await sdk.flushSave();
  const put = be.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/' + encodeURIComponent('game:gid-1'));
  assert.equal(p.syncState, 'synced');
  assert.deepEqual((await p.loadSave()).doc, { schemaVersion: 1, progress: { lastStage: 3 } });

  p.patchSettings({ muted: true });
  await new Promise((r) => setTimeout(r, 10));
  const patch = be.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.url, '/api/v1/games/gid-1/settings');
  assert.deepEqual(patch.body, { settings: { muted: true } });
  assert.deepEqual(await p.getSettings(), { muted: true });

  assert.deepEqual(await p.loadBindings({ throttle: ['ArrowUp', 'KeyW'], brake: ['ArrowDown'] }), { throttle: ['KeyI'], brake: ['ArrowDown'] });
  assert.ok(p.inviteLink().endsWith('/game-invite/user-123456789/gid-1'));
  assert.ok(be.calls.every((c) => c.auth === 'Bearer ' + sdk.token));
  sdk.signOut();
});

test('standalone: no token, no platform calls', async () => {
  let fetched = 0;
  const { p } = make('', async () => { fetched++; throw new Error('no network'); });
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), false);
  assert.equal((await p.loadSave()).ok, false);
  p.queueSave({ a: 1 });
  p.flushSave();
  p.patchSettings({ a: 1 });
  await p.loadProfile();
  assert.deepEqual(await p.getSettings(), {});
  assert.deepEqual(await p.loadBindings({ undo: ['KeyU'] }), { undo: ['KeyU'] });
  assert.equal(p.inviteLink(), null);
  assert.equal((await p.syncTime()).ok, false);
  assert.equal((await p.getLeaderboard()).ok, false);
  assert.ok(/^\d{4}-\d\d-\d\d$/.test(p.todayUTC()));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetched, 0);
});

test('hosted domain without token offers sign-in', () => {
  const { p } = make('', async () => { throw new Error('x'); }, 'gid-1.starhermit.com');
  assert.equal(p.canSignIn(), true);
});
