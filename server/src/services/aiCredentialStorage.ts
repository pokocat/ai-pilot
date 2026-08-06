// AI 模型凭证的存储口径。
//
// 产品决策（2026-08-05）：AiSetting / AiModel 内的对话、Embedding、Rerank API Key
// 直接明文存库，不再依赖 APP_ENCRYPTION_KEY。这样预发复制模型配置、备份恢复与密钥轮换
// 不会再出现“配置行存在但模型 Key 解不开”的额外故障面。
//
// 读取仍兼容 2026-06 起写入的 enc:v1 密文，供滚动部署和一次性迁移使用；新写入只能落明文。

import { decryptFailed, decryptSecret, decryptSecretSafe } from './secretBox.js';

/** 运行时读取：明文原样返回，历史 enc:v1 密文在主密钥可用时解密。 */
export function readAiCredential(value: string | null | undefined): string {
  return decryptSecretSafe(value);
}

/** 外部配置的新写入口径：用户提交什么就明文保存什么，不把看起来像 enc:v1 的合法 Key 误判为密文。 */
export function storeAiCredential(value: string | null | undefined): string {
  return value ?? '';
}

/** 内部迁移/模型切换入口：若传入历史密文先解开再保存，绝不把旧密文复制到新行。 */
export function plainAiCredential(value: string | null | undefined): string {
  return decryptSecret(value);
}

/** 仅用于滚动迁移期识别旧密文无法读取；明文永远不会依赖主密钥。 */
export function aiCredentialReadFailed(value: string | null | undefined): boolean {
  return decryptFailed(value);
}
