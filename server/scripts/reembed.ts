// 重新嵌入存量数据（知识库切片 + 长期记忆）。
// **切换嵌入来源后必跑**（本地↔远程、换嵌入模型）——否则存量向量维度与新查询向量不一致，
// cosine 维度不匹配返回 0，向量召回会**静默失效**（参见 services/embedding.ts 顶部说明）。
// 也可在运营后台「知识库」点「重新嵌入存量」（同一逻辑 reembedAll）。
// 用法：cd server && npm run db:reembed
import { prisma } from '../src/db.js';
import { reembedAll } from '../src/services/knowledgeAdmin.js';

reembedAll()
  .then((r) => console.log(JSON.stringify(r)))
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
