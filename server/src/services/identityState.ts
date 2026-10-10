import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { IdentityError } from './identity.js';

export async function lockIdentityUid(tx: Prisma.TransactionClient, uid: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`identity:${uid}`}, 0))`;
}

export async function requireIdentityActive(uid: string, db: Pick<Prisma.TransactionClient, 'identitySubject'> = prisma): Promise<bigint> {
  const row = await db.identitySubject.findUnique({ where: { uid } });
  if (row && row.status !== 'ACTIVE') throw new IdentityError('登录状态已失效，请重新登录', 401, 'IDENTITY_ACCOUNT_DISABLED');
  return row?.lastEventId ?? 0n;
}

export async function requireLocalIdentityActive(uid: string | null): Promise<void> {
  if (uid) await requireIdentityActive(uid);
}
