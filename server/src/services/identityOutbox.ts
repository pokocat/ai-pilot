import { prisma } from '../db.js';
import { identityEnabled, identityMachineRequest } from './identity.js';
import { lockIdentityUid } from './identityState.js';
import { resetIdentityUserCache } from './identityProvisioning.js';
import { eraseAccount } from './accountDeletion.js';

export interface IdentityEvent { id: number; eventType: string; uid: string; productCode?: string | null; payload: Record<string, unknown> | null }
const known = new Set(['USER_CLOSED', 'USER_MERGED', 'USER_SUSPENDED', 'USER_UNSUSPENDED', 'PHONE_CHANGED', 'PROFILE_CHANGED']);
const lifecycle = new Set(['USER_CLOSED', 'USER_MERGED']);
function invalid(): never { throw new Error('IDENTITY_OUTBOX_INVALID'); }
function uid(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 128) return invalid(); return value; }
export function parseIdentityEvents(data: unknown, after: number, product: string): IdentityEvent[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid();
  const page = data as { events?: unknown; nextAfter?: unknown };
  if (!Array.isArray(page.events) || page.events.length > 100) return invalid();
  let prior = after;
  const events = page.events.map((raw): IdentityEvent => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const row = raw as IdentityEvent;
    if (!Number.isSafeInteger(row.id) || row.id <= prior || typeof row.eventType !== 'string' || !row.eventType.trim()) return invalid();
    if (row.productCode !== null && row.productCode !== undefined && row.productCode !== product) return invalid();
    prior = row.id;
    if (known.has(row.eventType)) {
      uid(row.uid);
      if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) return invalid();
      if (row.payload.uid !== undefined && row.payload.uid !== row.uid) return invalid();
      if (row.eventType === 'USER_MERGED') {
        if (uid(row.payload.fromUid) !== row.uid || uid(row.payload.toUid) === row.uid) return invalid();
      }
      if (row.eventType === 'PROFILE_CHANGED') {
        for (const key of ['displayName', 'avatarUrl']) if (row.payload[key] !== undefined && row.payload[key] !== null && typeof row.payload[key] !== 'string') return invalid();
        if (typeof row.payload.avatarUrl === 'string' && row.payload.avatarUrl && !row.payload.avatarUrl.startsWith('https://')) return invalid();
      }
    }
    return row;
  });
  if (!Number.isSafeInteger(page.nextAfter) || page.nextAfter !== prior) return invalid();
  return events;
}

/** Per-UID durable replay guard, shared with provisioning/profile writes. No wallet/rights moves. */
export async function applyIdentityEvent(event: IdentityEvent): Promise<void> {
  if (!known.has(event.eventType)) return;
  const toUid = event.eventType === 'USER_MERGED' ? uid(event.payload?.toUid) : null;
  const eraseId = await prisma.$transaction(async (tx) => {
    for (const key of [...new Set([event.uid, ...(toUid ? [toUid] : [])])].sort()) await lockIdentityUid(tx, key);
    const previous = await tx.identitySubject.findUnique({ where: { uid: event.uid } });
    if (previous && previous.lastEventId >= BigInt(event.id)) return previous.status === 'CLOSED' ? previous.localSubjectId : null;
    if (previous && ['CLOSED', 'MERGED'].includes(previous.status)) return null;
    const local = await tx.user.findUnique({ where: { identityUid: event.uid } });
    let status = previous?.status ?? 'ACTIVE';
    let erase: string | null = null;
    if (event.eventType === 'USER_CLOSED') {
      status = 'CLOSED'; erase = local?.id ?? null;
      if (local) await tx.user.update({ where: { id: local.id }, data: { deletedAt: new Date(), identityTokenVersion: { increment: 1 } } });
    } else if (event.eventType === 'USER_MERGED' && toUid) {
      const targetState = await tx.identitySubject.findUnique({ where: { uid: toUid } });
      if (targetState && ['CLOSED', 'MERGED'].includes(targetState.status)) throw new Error('IDENTITY_MERGE_TARGET_DISABLED');
      status = 'MERGED';
      const survivor = await tx.user.findUnique({ where: { identityUid: toUid } });
      if (local) await tx.user.update({ where: { id: local.id }, data: {
        ...(!survivor ? { identityUid: toUid } : {}),
        phone: `id_unbound_${local.id}`, identityTokenVersion: { increment: 1 },
      } });
    } else if (event.eventType === 'USER_SUSPENDED') {
      status = 'SUSPENDED';
      if (local && previous?.status !== 'SUSPENDED') await tx.user.update({ where: { id: local.id }, data: { identityTokenVersion: { increment: 1 } } });
    } else if (event.eventType === 'USER_UNSUSPENDED') status = 'ACTIVE';
    else if (event.eventType === 'PHONE_CHANGED' && local) {
      await tx.user.update({ where: { id: local.id }, data: { phone: `id_unbound_${local.id}`, identityTokenVersion: { increment: 1 } } });
    } else if (event.eventType === 'PROFILE_CHANGED' && local) {
      const payload = event.payload!;
      await tx.user.update({ where: { id: local.id }, data: {
        ...(typeof payload.displayName === 'string' && payload.displayName.trim() ? { name: payload.displayName } : {}),
        ...(Object.hasOwn(payload, 'avatarUrl') ? { avatarUrl: typeof payload.avatarUrl === 'string' && payload.avatarUrl.trim() ? payload.avatarUrl : null } : {}),
      } });
    }
    await tx.identitySubject.upsert({ where: { uid: event.uid },
      create: { uid: event.uid, status, localSubjectId: local?.id, lastEventId: BigInt(event.id) },
      update: { status, localSubjectId: local?.id ?? previous?.localSubjectId, lastEventId: BigInt(event.id) },
    });
    return erase;
  });
  resetIdentityUserCache();
  // Existing erasure workflow is itself durable/idempotent. Retry this step
  // after crashes before acknowledging closure; keep business retention policy.
  if (event.eventType === 'USER_CLOSED' && eraseId) await eraseAccount(eraseId);
}

export async function pollIdentityOutbox(): Promise<void> {
  if (!identityEnabled() || process.env.ID_OUTBOX_ENABLED !== 'true') return;
  const product = (process.env.ID_PRODUCT_CODE ?? '').trim();
  if (!product || !process.env.ID_SERVER_CLIENT_ID?.trim() || !process.env.ID_SERVER_CLIENT_SECRET?.trim()) throw new Error('IDENTITY_OUTBOX_NOT_CONFIGURED');
  const cursor = await prisma.identityOutboxCursor.upsert({ where: { product }, create: { product }, update: {} });
  const after = Number(cursor.after);
  if (!Number.isSafeInteger(after)) return invalid();
  const events = parseIdentityEvents(await identityMachineRequest('GET', product, `outbox?after=${after}&limit=100`), after, product);
  for (const event of events) {
    await applyIdentityEvent(event);
    if (event.eventType === 'USER_MERGED') {
      const target = String(event.payload!.toUid);
      const survivor = await prisma.user.findUnique({ where: { identityUid: target }, select: { id: true } });
      if (survivor) await identityMachineRequest('PUT', product, `links/${encodeURIComponent(target)}`, { localSubjectId: survivor.id, status: 'PROVISIONED' });
    }
    if (lifecycle.has(event.eventType)) {
      const receipt = await identityMachineRequest('PUT', product, `outbox/${event.id}/receipt`, { status: 'COMPLETED' }) as { recorded?: unknown } | null;
      if (receipt?.recorded !== true) invalid();
    }
    await prisma.identityOutboxCursor.updateMany({ where: { product, after: { lt: BigInt(event.id) } }, data: { after: BigInt(event.id) } });
  }
}

export function assertIdentityOutboxConfigured(): void {
  if (!identityEnabled()) return;
  if (process.env.NODE_ENV === 'production' && process.env.ID_OUTBOX_ENABLED !== 'true') throw new Error('IDENTITY_OUTBOX_REQUIRED');
  if (process.env.ID_OUTBOX_ENABLED === 'true' && (!/^[a-z][a-z0-9-]*$/.test(process.env.ID_PRODUCT_CODE ?? '') || !process.env.ID_SERVER_CLIENT_ID?.trim() || !process.env.ID_SERVER_CLIENT_SECRET?.trim())) throw new Error('IDENTITY_OUTBOX_NOT_CONFIGURED');
}
