// 海报成品图（canvas_design）C 端路由。鉴权/错误风格对齐 routes/brandKit.ts：
// resolveUser（无/失效 token 一律 401）+ `{ error, code }` 错误体 + 服务层抛错带 statusCode/code 直接转发。
//
// 错误码约定（方案 §9）：
//   401 未登录 · 402 INSUFFICIENT_CREDITS · 403 AGENT_LOCKED | PLAN_EXPIRED | CANVAS_DISABLED
//   404 NOT_FOUND（含越权：不区分「不存在」与「不是你的」，否则接口本身就是探测器）
//   422 校验 · 429 CREATIVE_DAILY_LIMIT
//   （**没有 409**：命中幂等键回 200 + reused=true，见建单端点的说明。曾在这里写着
//    409 IDEMPOTENCY_CONFLICT，但代码从来没返回过它 —— 文档注释也是会撒谎的地方。）
import type { FastifyInstance, FastifyReply } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { getCreativeConfig, enabledTemplateOptions, premiumTierAvailable } from '../services/creative/config.js';
import { buildPosterBriefDraft } from '../services/creative/briefDraft.js';
import { getDirectionSampleFile, publishedDirectionOptions } from '../services/creative/directionSamples.js';
import {
  createPosterJob, reviseJob, regenerateJob, cancelJob, getJobView, listPosterJobs,
} from '../services/creative/jobs.js';
import { ingestSourceAsset } from '../services/creative/uploads.js';
import { creativeStorageReady, getCreativeObject } from '../services/creative/storage.js';
import { ossConfigured, ossSignedUrl } from '../services/ossUpload.js';
import { imageExtFromMime, MAX_IMAGE_BYTES } from '../services/chatImage.js';
import type {
  CreatePosterJobRequest, RevisePosterJobRequest, RegeneratePosterJobRequest, CreativeStatusResult,
} from '../../../shared/contracts';

/** 服务层错误 → HTTP。带 statusCode/code 的按原样转发；其余按 fallback。 */
function sendErr(reply: FastifyReply, e: unknown, fallback = 400) {
  const err = e as { statusCode?: number; code?: string; message?: string };
  return reply.code(err.statusCode ?? fallback).send({ error: err.message ?? '操作失败', code: err.code });
}

export async function creativeRoutes(app: FastifyInstance) {
  // 能力状态：小程序据此决定是否显示出图入口（方案 §16 降级口径）——关闭时整块隐藏，
  // 而不是露出按钮再让用户点到 403。刻意做成最轻的一次查询（只读配置，不查任务/余额），
  // 因为它会被成果卡渲染时高频调用。
  //
  // 同时下发**启用中的版式清单**：前端此前硬编码三套恒可选，运营停用一套之后用户照样能选到它，
  // 而服务端对显式请求停用模板一律 422（此前是静默换版 + 照常扣费，更糟）。清单从这里来才不会脱节。
  app.get('/creative/status', async (req): Promise<CreativeStatusResult> => {
    await resolveUser(req.headers['x-user-id'] as string | undefined); // 需登录（401 由 resolveUser 抛）
    const cfg = await getCreativeConfig();
    const premiumAvailable = cfg.enabled && premiumTierAvailable(cfg);
    return {
      enabled: cfg.enabled,
      pricePerPoster: cfg.pricePerPoster,
      premiumPricePerPoster: cfg.premiumPricePerPoster,
      // 与 templates 同一条口径：不可用就别露出来。高级档不可用时前端不该显示那个选项，
      // 更不该显示价格 —— 让用户选完再撞 422 是最差的一种交互。
      premiumAvailable,
      directions: cfg.enabled ? await publishedDirectionOptions(premiumAvailable) : [],
      // 功能关着时不下发清单：前端本就该整块隐藏入口，给了列表反而像"能用"。
      templates: cfg.enabled ? enabledTemplateOptions(cfg) : [],
    };
  });

  // 全局方向样例是对外运营物料，不含用户/租户资产；cuid 不可猜，可被 <image> 直接加载（故不设 resolveUser）。
  // **只发已发布样例**：这条路由无鉴权，草稿/归档是未审核或已下线的物料，不得从这里流出
  // （后台预览草稿走 /admin/creative/direction-samples/:id/file，那条有管理鉴权）。
  app.get<{ Params: { id: string } }>('/creative/direction-samples/:id/file', async (req, reply) => {
    const file = await getDirectionSampleFile(req.params.id);
    if (!file) return reply.code(404).send({ error: '样例不存在', code: 'NOT_FOUND' });
    return reply
      .header('content-type', file.mimeType)
      .header('cache-control', 'public, max-age=600')
      .send(file.buffer);
  });

  // 需求单草稿：成果消息 + 已确认 BrandKit 预填（用户在确认页只做增删改）。
  app.get<{ Querystring: { sessionId?: string; messageId?: string } }>('/creative/posters/brief-draft', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      return await buildPosterBriefDraft({
        userId: user.id,
        sessionId: (req.query.sessionId ?? '').trim() || null,
        messageId: (req.query.messageId ?? '').trim() || null,
      });
    } catch (e) {
      return sendErr(reply, e, 422);
    }
  });

  // 源素材上传（人像 / Logo / 二维码，multipart 单文件）。约束同聊天图片上传：MIME 白名单 + 10MB。
  // role 只从 **multipart 字段**取（曾同时接 query，两个入口对同一个字段是无谓的分叉；role 本身
  // 也只是存档元信息，见 uploads.ts 的说明）。
  app.post('/creative/uploads', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    if (!creativeStorageReady() && process.env.NODE_ENV !== 'test') {
      return reply.code(503).send({ error: '图片存储未配置', code: 'OSS_NOT_CONFIGURED' });
    }
    let data;
    try {
      data = await req.file();
    } catch {
      return reply.code(413).send({ error: '图片过大（单张上限 10MB）', code: 'IMAGE_TOO_LARGE' });
    }
    if (!data) return reply.code(400).send({ error: '未收到图片', code: 'FILE_REQUIRED' });
    if (!imageExtFromMime(data.mimetype)) {
      return reply.code(415).send({ error: '仅支持 JPG / PNG / GIF / WebP 图片', code: 'IMAGE_BAD_TYPE' });
    }
    let buf: Buffer;
    try {
      buf = await data.toBuffer();
    } catch {
      return reply.code(413).send({ error: '图片过大（单张上限 10MB）', code: 'IMAGE_TOO_LARGE' });
    }
    if (data.file.truncated || buf.length > MAX_IMAGE_BYTES) {
      return reply.code(413).send({ error: '图片过大（单张上限 10MB）', code: 'IMAGE_TOO_LARGE' });
    }
    const roleField = (data.fields as Record<string, { value?: string } | undefined> | undefined)?.role?.value;
    try {
      return await ingestSourceAsset({
        tenantId: user.tenantId,
        userId: user.id,
        mimeType: data.mimetype,
        buf,
        role: roleField,
        fileName: data.filename ?? null,
      });
    } catch (e) {
      return sendErr(reply, e, 422);
    }
  });

  // 建任务。门禁顺序在服务层（功能开关 → 解锁 → 套餐 → 校验 → 审核 → 幂等 → 限额 → 扣费）。
  app.post<{ Body: CreatePosterJobRequest }>('/creative/posters', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const r = await createPosterJob(user, req.body?.brief, {
        sessionId: req.body?.sessionId ?? null,
        messageId: req.body?.messageId ?? null,
        idempotencyKey: req.body?.idempotencyKey ?? '',
      });
      // 命中幂等键返回 200 + reused（不是 409）：客户端重复点击拿回原任务是**正常结果**，
      // 409 会被前端错误分支吞成"失败"。真正的冲突（同 key 不同入参）在服务层无从判定，故不造假。
      return reply.code(r.reused ? 200 : 201).send(r);
    } catch (e) {
      return sendErr(reply, e, 422);
    }
  });

  // 作品库：本人的历史成品图列表（createdAt 倒序 + 游标分页）。
  //
  // 为什么需要它：此前小程序**没有**任何面向 C 端的任务列表接口，只有按 id 查。用户一离开成品图详情页，
  // 就只能回到产出它的那张成果卡点「查看成品图」才能找回海报，而成果卡只记得最近一次出图 ——
  // 早期版本得顺着版本链一层层往上翻。列表接口是把这些资产变成"可浏览"的前提。
  //
  // **不进任何响应缓存**（本路由刻意不碰 services/cache 的 cacheGet/cacheSet）：每项都带 600 秒的
  // OSS 短签名 URL，缓存下来过期后就是一格破图；而且那是私有资产（人像/企业物料）的直连地址，
  // 留在共享缓存里等于把它发给了下一个请求者。响应头同样按私有 + no-store 下发。
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/creative/posters', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const r = await listPosterJobs(user.id, {
        cursor: (req.query.cursor ?? '').trim() || null,
        limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
      });
      reply.header('cache-control', 'private, max-age=0, no-store');
      return r;
    } catch (e) {
      return sendErr(reply, e, 422);
    }
  });

  app.get<{ Params: { id: string } }>('/creative/jobs/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      return await getJobView(req.params.id, user.id);
    } catch (e) {
      return sendErr(reply, e, 404);
    }
  });

  // 只改文案重排（不扣钻石）。
  app.post<{ Params: { id: string }; Body: RevisePosterJobRequest }>('/creative/jobs/:id/revise', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      return await reviseJob(user, req.params.id, req.body ?? {});
    } catch (e) {
      return sendErr(reply, e, 422);
    }
  });

  // 重出主视觉（重新扣费）。
  app.post<{ Params: { id: string }; Body: RegeneratePosterJobRequest }>('/creative/jobs/:id/regenerate', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      return await regenerateJob(user, req.params.id, req.body ?? {});
    } catch (e) {
      return sendErr(reply, e, 422);
    }
  });

  app.post<{ Params: { id: string } }>('/creative/jobs/:id/cancel', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      return await cancelJob(user, req.params.id);
    } catch (e) {
      return sendErr(reply, e, 404);
    }
  });

  // 资产文件：归属校验 → 配了 OSS 就 302 到短签名 URL（省服务端带宽），否则流式返回（测试/本地内存回退）。
  app.get<{ Params: { id: string } }>('/creative/assets/:id/file', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    // 越权一律 404（不回 403：403 会告诉探测者「这个 id 存在」）。
    const asset = await prisma.creativeAsset.findFirst({
      where: { id: req.params.id, userId: user.id },
      select: { ossKey: true, mimeType: true },
    });
    if (!asset?.ossKey) return reply.code(404).send({ error: '资产不存在', code: 'NOT_FOUND' });
    // fastify 5 的签名是 redirect(url, code)（4.x 的 (code, url) 已移除）。
    if (ossConfigured()) return reply.redirect(ossSignedUrl(asset.ossKey, 600), 302);
    const buf = await getCreativeObject(asset.ossKey);
    if (!buf?.length) return reply.code(404).send({ error: '资产不存在', code: 'NOT_FOUND' });
    return reply
      .header('content-type', asset.mimeType)
      .header('cache-control', 'private, max-age=0, no-store')
      .send(buf);
  });
}
