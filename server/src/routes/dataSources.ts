// V7-07 数据源路由：智库 data 面板数据源 + 上传替代资料 / 高级授权登记两条状态流转。
// 所有读写按 userId 行级隔离（resolveUser 首行）；未知 sourceKey → 404。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { isKnownDataSource } from '../data/dataSources.js';
import { listForUser, recordUpload, requestAuth } from '../services/dataSources.js';

export async function dataSourceRoutes(app: FastifyInstance) {
  // 数据源目录 + 用户状态合并视图（智库 data 面板；hero 三指标服务端算）
  app.get('/data-sources', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return listForUser({ tenantId: user.tenantId, userId: user.id });
  });

  // 上传替代资料 → 状态置 uploaded（body.knowledgeId 可选，关联 V7-06 已上传条目）
  app.post<{ Params: { key: string }; Body: { knowledgeId?: string } }>(
    '/data-sources/:key/upload',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const key = req.params.key;
      if (!isKnownDataSource(key)) {
        return reply.code(404).send({ error: '数据源不存在', code: 'DATA_SOURCE_NOT_FOUND' });
      }
      const knowledgeId = typeof req.body?.knowledgeId === 'string' ? req.body.knowledgeId : undefined;
      return recordUpload({ tenantId: user.tenantId, userId: user.id, sourceKey: key, knowledgeId });
    },
  );

  // 高级授权登记（OAuth 预约，运营跟进）→ 状态置 auth_requested
  app.post<{ Params: { key: string } }>('/data-sources/:key/request-auth', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const key = req.params.key;
    if (!isKnownDataSource(key)) {
      return reply.code(404).send({ error: '数据源不存在', code: 'DATA_SOURCE_NOT_FOUND' });
    }
    return requestAuth({ tenantId: user.tenantId, userId: user.id, sourceKey: key });
  });
}
