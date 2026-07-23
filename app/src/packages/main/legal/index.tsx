import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import './index.scss';

// 合规文本脚手架。正文均为占位，标注【待法务替换】——上线前须由法务出具正式文本替换。
// 结构与「实际收集项」如实列出，供法务起草参考；隐私政策的收集项与产品实现保持一致。
type Section = { h: string; body: string[] };
type Doc = { title: string; updated: string; intro: string; sections: Section[] };

const DOCS: Record<string, Doc> = {
  agreement: {
    title: '用户协议',
    updated: '【待法务替换 · 生效日期】',
    intro: '【待法务替换】以下为占位条款，仅示意结构，不构成正式协议。军师为创始人 / 管理者提供 AI 商业参谋服务。',
    sections: [
      { h: '一、服务内容', body: ['【待法务替换】军师基于人工智能为你提供经营分析、策略建议、报告生成等参考性服务。'] },
      { h: '二、AI 产出的性质与免责', body: [
        '【待法务替换】AI 产出为参考信息，不构成投资、财务、法律等专业意见；重大经营决策请结合专业意见与自身判断。',
        '你对使用本服务作出的决策及其后果自行负责。',
      ] },
      { h: '三、账号与你的责任', body: ['【待法务替换】你应对账号下的内容、上传资料及操作负责，不得用于违法或侵害他人权益的用途。'] },
      { h: '四、付费与订阅', body: ['【待法务替换】付费套餐 / 单次付费的权益、计费周期、到期规则以购买页展示为准；退款见《退款政策》。'] },
      { h: '五、知识产权', body: ['【待法务替换】。'] },
      { h: '六、服务变更与终止', body: ['【待法务替换】。'] },
      { h: '七、争议解决与联系方式', body: ['【待法务替换 · 补充经营主体、联系方式、管辖】。'] },
    ],
  },
  privacy: {
    title: '隐私政策',
    updated: '【待法务替换 · 生效日期】',
    intro: '【待法务替换】以下为占位条款，仅示意结构。我们重视你的个人信息保护，依《个人信息保护法》等规定处理你的信息。',
    sections: [
      { h: '一、我们收集哪些信息', body: [
        '为提供服务，我们会收集以下信息（如实列出，供法务核对补全）：',
        '· 手机号（登录 / 注册与账号唯一标识）',
        '· 微信账号信息：openid / unionid、你授权的头像与昵称',
        '· 你主动填写的企业经营信息（行业、营收区间、经营档案等）',
        '· 你与军师的对话内容、生成的报告与方案',
        '· 你上传的资料文档（用于知识库检索与分析）',
        '· 敏感信息：生辰八字等（仅在你使用相关功能并单独授权时收集）【待法务替换 · 敏感信息范围与单独同意】',
      ] },
      { h: '二、我们如何使用信息', body: ['【待法务替换】用于生成与你相关的产出、改进服务、保障账号与资金安全等。'] },
      { h: '三、我们是否向第三方提供', body: [
        '【待法务替换】我们不向第三方出售你的个人信息。',
        '为实现功能，AI 推理由第三方大模型服务提供商处理你的输入；短信、支付、云存储等由相应服务商提供。【待法务替换 · 列明委托处理方与目的】',
      ] },
      { h: '四、信息的存储与保护', body: ['【待法务替换 · 存储地域、期限、安全措施】。'] },
      { h: '五、你的权利', body: [
        '【待法务替换】你可查询、复制、更正、删除你的个人信息，或注销账号。',
        '注销账号将永久删除你的账号、对话、方案库与全部数据（可在「设置 → 注销账号」操作）。',
      ] },
      { h: '六、未成年人', body: ['【待法务替换】本服务面向企业经营者，未成年人不适用；如为未成年人请在监护人指导下使用。'] },
      { h: '七、联系我们', body: ['【待法务替换 · 个人信息保护负责人 / 联系方式】。'] },
    ],
  },
  refund: {
    title: '退款政策',
    updated: '【待法务替换 · 生效日期】',
    intro: '【待法务替换】以下为占位条款，仅示意结构。本政策说明付费套餐与单次付费的退款规则。',
    sections: [
      { h: '一、适用范围', body: ['【待法务替换】适用于通过本小程序购买的套餐与单次付费商品。'] },
      { h: '二、退款条件', body: ['【待法务替换 · 未消耗 / 已消耗、按比例、冷静期等规则】。'] },
      { h: '三、如何申请退款', body: ['【待法务替换】可通过「设置 → 联系客服」提交退款申请，我们将在约定时限内处理。'] },
      { h: '四、退款处理时限与方式', body: ['【待法务替换 · 原路退回、到账时间】。'] },
      { h: '五、发票', body: ['【待法务替换 · 开票方式与时限】。'] },
    ],
  },
};

export default function Legal() {
  const s = useStore();
  const params = (Taro.getCurrentInstance().router?.params ?? {}) as { doc?: string };
  const doc = DOCS[params.doc ?? 'agreement'] ?? DOCS.agreement;

  return (
    <View className={`page legal ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title={doc.title} onBack={() => Taro.navigateBack()} />
      <View className="pad">
        <Text className="lgl-updated">更新日期：{doc.updated}</Text>
        <Text className="lgl-intro">{doc.intro}</Text>
        {doc.sections.map((sec) => (
          <View className="lgl-sec" key={sec.h}>
            <Text className="lgl-h">{sec.h}</Text>
            {sec.body.map((p, i) => (
              <Text className="lgl-p" key={i}>{p}</Text>
            ))}
          </View>
        ))}
        <Text className="lgl-foot">本页文本为占位版本，正式条款以法务发布为准。</Text>
      </View>
    </View>
  );
}
