-- 声量AI 代售军师套餐的开通记录表（STUDIO_WEB_API.md §3、§7）。
-- 纯加法 expand：只建一张新表和三个索引，不改、不删任何已有结构；旧版本代码不读这张表，先建表再发布是安全的。
-- 由 `prisma migrate diff --from-schema-datamodel <origin/main 25fe80cd> --to-schema-datamodel server/prisma/schema.prisma --script` 生成，未手改。
-- 执行：发布前由有 DDL 权限的账号在正式 RDS 跑一次（运行账号没有建表权限）；然后 `deploy-prod.sh --schema-reviewed` 只读核对结构一致。
-- 回退：新代码下线后才可 DROP TABLE "external_plan_grant";（表里是代售到账账本，回退前先导出）。
BEGIN;

CREATE TABLE IF NOT EXISTS "external_plan_grant" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "identityUid" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "userId" TEXT,
    "tenantId" TEXT,
    "resultJson" JSONB,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_plan_grant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "external_plan_grant_identityUid_status_idx" ON "external_plan_grant"("identityUid", "status");
CREATE INDEX IF NOT EXISTS "external_plan_grant_userId_idx" ON "external_plan_grant"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "external_plan_grant_source_orderNo_key" ON "external_plan_grant"("source", "orderNo");

COMMIT;
