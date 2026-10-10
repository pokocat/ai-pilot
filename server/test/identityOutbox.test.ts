import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { applyIdentityEvent, parseIdentityEvents, pollIdentityOutbox, type IdentityEvent } from '../src/services/identityOutbox.js';
import { requireIdentityActive } from '../src/services/identityState.js';
import { resolveUser } from '../src/services/context.js';
import { signUserToken } from '../src/services/userToken.js';
import { cleanBusiness, closeApp } from './helpers.js';

const event = (id: number, eventType: string, uid = 'from', payload: Record<string, unknown> = {}): IdentityEvent => ({ id, eventType, uid, payload, productCode: null });
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await cleanBusiness();
  process.env.APP_JWT_SECRET = 'identity-outbox-test-secret-long-enough';
  process.env.APP_JWT_REQUIRED = 'true';
  delete process.env.ID_ISSUER;
  delete process.env.ID_OUTBOX_ENABLED;
  globalThis.fetch = originalFetch;
});
after(async () => { globalThis.fetch = originalFetch; await closeApp(); });
async function user(uid = 'from') {
  const tenant = await prisma.tenant.create({ data: { name: 'identity fixture' } });
  return prisma.user.create({ data: { tenantId: tenant.id, phone: uid === 'from' ? '13900001111' : '13900002222', name: 'fixture', identityUid: uid, role: 'owner' } });
}

test('strict published pages reject malformed/foreign events before any cursor advance', () => {
  for (const data of [
    { events: [event(1.5, 'USER_CLOSED')], nextAfter: 1.5 },
    { events: [{ ...event(1, 'USER_CLOSED'), productCode: 'other' }], nextAfter: 1 },
    { events: [event(1, 'USER_MERGED', 'from', { fromUid: 'wrong', toUid: 'to' })], nextAfter: 1 },
    { events: [], nextAfter: 1 },
  ]) assert.throws(() => parseIdentityEvents(data, 0, 'quickreel'));
  assert.equal(parseIdentityEvents({ events: [event(2, 'UNKNOWN_FUTURE')], nextAfter: 2 }, 0, 'quickreel').length, 1);
});

test('closure before JIT persists a tombstone; closure revokes local JWT and creates one erasure job', async () => {
  await applyIdentityEvent(event(1, 'USER_CLOSED', 'unseen'));
  await assert.rejects(requireIdentityActive('unseen'));
  const local = await user();
  const token = signUserToken(local.id);
  assert.equal((await resolveUser(token)).id, local.id);
  await applyIdentityEvent(event(2, 'USER_CLOSED'));
  await applyIdentityEvent(event(2, 'USER_CLOSED'));
  await applyIdentityEvent(event(3, 'USER_UNSUSPENDED'));
  await assert.rejects(resolveUser(token));
  assert.equal(await prisma.dataErasureJob.count({ where: { subjectUserId: local.id } }), 1);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: local.id } })).identityTokenVersion, 1);
  assert.equal((await prisma.identitySubject.findUniqueOrThrow({ where: { uid: 'from' } })).status, 'CLOSED');
});

test('suspend replay cannot undo a newer suspend', async () => {
  const local = await user();
  for (const [id, kind] of [[10, 'USER_SUSPENDED'], [11, 'USER_UNSUSPENDED'], [12, 'USER_SUSPENDED'], [11, 'USER_UNSUSPENDED']] as const) await applyIdentityEvent(event(id, kind));
  await assert.rejects(requireIdentityActive('from'));
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: local.id } })).identityTokenVersion, 2);
});

test('merge preserves business ID/tenant/role while revoking old UID and local session', async () => {
  const local = await user(); const token = signUserToken(local.id);
  await applyIdentityEvent(event(1, 'USER_MERGED', 'from', { fromUid: 'from', toUid: 'to' }));
  const next = await prisma.user.findUniqueOrThrow({ where: { identityUid: 'to' } });
  assert.equal(next.id, local.id); assert.equal(next.tenantId, local.tenantId); assert.equal(next.role, local.role);
  await assert.rejects(requireIdentityActive('from'));
  await assert.rejects(resolveUser(token));
  assert.equal((await resolveUser(signUserToken(next.id, { extra: { iv: next.identityTokenVersion } }))).id, local.id);
});

test('merge with two existing users leaves both business IDs and target rights intact', async () => {
  const source = await user(); const target = await user('to');
  await applyIdentityEvent(event(1, 'USER_MERGED', 'from', { fromUid: 'from', toUid: 'to' }));
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { identityUid: 'to' } })).id, target.id);
  assert.equal(await prisma.user.count(), 2);
  await assert.rejects(resolveUser(signUserToken(source.id, { extra: { iv: 1 } })));
});

test('phone/profile changes clear stale phone and avatar without changing rights', async () => {
  const local = await user(); const token = signUserToken(local.id);
  await applyIdentityEvent(event(1, 'PHONE_CHANGED'));
  await applyIdentityEvent(event(2, 'PROFILE_CHANGED', 'from', { displayName: 'updated', avatarUrl: null }));
  const next = await prisma.user.findUniqueOrThrow({ where: { id: local.id } });
  assert.equal(next.phone, `id_unbound_${local.id}`); assert.equal(next.name, 'updated'); assert.equal(next.avatarUrl, null);
  assert.equal(next.role, local.role); await assert.rejects(resolveUser(token));
});

test('failed lifecycle receipt stops cursor; replay acknowledges without another revocation', async () => {
  const local = await user();
  process.env.ID_ISSUER = 'https://id.example.test'; process.env.ID_OUTBOX_ENABLED = 'true';
  process.env.ID_PRODUCT_CODE = 'quickreel'; process.env.ID_SERVER_CLIENT_ID = 'quickreel-server'; process.env.ID_SERVER_CLIENT_SECRET = 'fixture-secret';
  let fail = true; let receipts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/token') return Response.json({ access_token: 'machine', token_type: 'Bearer', expires_in: 300, scope: 'product.link' });
    if (url.pathname.endsWith('/receipt')) {
      receipts++; assert.equal(init?.method, 'PUT'); assert.equal(init?.body, JSON.stringify({ status: 'COMPLETED' }));
      return fail ? new Response('', { status: 503 }) : Response.json({ success: true, data: { recorded: true } });
    }
    return Response.json({ success: true, data: { events: [event(1, 'USER_CLOSED')], nextAfter: 1 } });
  };
  await assert.rejects(pollIdentityOutbox());
  assert.equal((await prisma.identityOutboxCursor.findUniqueOrThrow({ where: { product: 'quickreel' } })).after, 0n);
  fail = false; await pollIdentityOutbox();
  assert.equal((await prisma.identityOutboxCursor.findUniqueOrThrow({ where: { product: 'quickreel' } })).after, 1n);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: local.id } })).identityTokenVersion, 1);
  assert.equal(receipts, 2);
});
