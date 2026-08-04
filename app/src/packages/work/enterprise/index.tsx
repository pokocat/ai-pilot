import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { ENTERPRISE_SERVICES } from '../../../data/operatingSystem';
import { navTo, switchTo } from '../../../services/nav';
import './index.scss';

// 企业服务办理台（新设计稿 service-record）——军师诊断后触发的企业基础服务：工商 / 财税 / 商标 / 版权 / 合同 / 资质。
// 这里刻意**不是服务商城**：军师只做诊断、资料清单、路径建议和进度管理，实际办理由专业服务方承接。
// 用户侧的「办理进度」还没有后端建模，所以本页不显示进度数字，只显示触发条件、资料清单和交接边界；
// 真要办理的动线是「问军师确认要不要办」→「服务老师对接服务商」，两个入口都在页尾。
export default function Enterprise() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const svc = s.me()?.service ?? null;
  const [open, setOpen] = useState('');

  return (
    <View className={`page ent-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="企业服务" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="ent-hero card">
          <Text className="kicker">Enterprise Service</Text>
          <Text className="h1">企业服务办理台</Text>
          <Text className="ent-p">
            这里看军师诊断后触发的企业基础服务，不是服务商城。军师负责诊断、资料清单、路径建议和进度管理；
            工商、财税、商标、知识产权和合同事项由专业服务方承接，结果以主管机关或专业意见为准。
          </Text>
        </View>

        {/* 办理结果的归档位置：本项目里企业资产就沉淀在资料库，不另造一个「资产云」概念 */}
        <View className="ent-cloud" onClick={() => navTo('/packages/work/knowledge/index')}>
          <View className="ent-cloud-ic" style={{ background: 'var(--accent-soft)' }}>
            <Icon name="layers" size={16} color={accent} />
          </View>
          <View className="ent-cloud-b">
            <Text className="ent-cloud-t">企业资产归档在资料库</Text>
            <Text className="ent-cloud-s">证照、商标、版权、合同、财税和授权规则统一沉淀，军师判断时可直接引用。</Text>
          </View>
          <Text className="ent-cloud-go">进入 ›</Text>
        </View>

        <View className="sec-head">
          <Text className="sec-title">六条服务线</Text>
          <Text className="sec-more">点开看资料清单</Text>
        </View>

        {ENTERPRISE_SERVICES.map((item) => {
          const on = open === item.key;
          return (
            <View key={item.key} className={`ent-card card ${on ? 'is-open' : ''}`} onClick={() => setOpen(on ? '' : item.key)}>
              <View className="ent-top">
                <View className="ent-b">
                  <Text className="ent-t serif">{item.title}</Text>
                  <Text className="ent-d">{item.desc}</Text>
                </View>
                <Text className="ent-fold" style={{ color: accent }}>{on ? '收起' : '展开'}</Text>
              </View>

              {/* 办理路径：静态路径示意，不是当前用户的进度——没有数据就不画进度条 */}
              <View className="ent-steps">
                {item.steps.map((st, i) => (
                  <View key={st} className="ent-step">
                    <Text className="ent-step-t">{st}</Text>
                    {i < item.steps.length - 1 ? <Text className="ent-step-arrow">›</Text> : null}
                  </View>
                ))}
              </View>

              {on ? (
                <View className="ent-detail">
                  <Text className="ent-dk">触发条件</Text>
                  <Text className="ent-dv">{item.trigger}</Text>

                  <Text className="ent-dk">要准备的资料</Text>
                  {item.materials.map((m, i) => (
                    <View key={m} className="ent-mat">
                      <Text className="ent-mat-i serif" style={{ background: 'var(--accent-soft)', color: accent }}>{i + 1}</Text>
                      <Text className="ent-mat-t">{m}</Text>
                    </View>
                  ))}

                  <Text className="ent-dk">服务商交接</Text>
                  <Text className="ent-dv">{item.handoff}</Text>

                  <Text className="ent-dk">结果回写</Text>
                  <Text className="ent-dv">{item.archive}</Text>
                </View>
              ) : null}
            </View>
          );
        })}

        <View className="ent-actions">
          {/* 走 switchTo（防重入锁），不裸调 Taro.switchTab——与全站 tab 跳转口径一致 */}
          <View className="ent-act ent-act-main" style={{ background: accent }} onClick={() => switchTo('/pages/sessions/index')}>
            <Text>先问军师要不要办</Text>
            <Icon name="send" size={15} color="#FBFAF6" />
          </View>
          <View className="ent-act" style={{ borderColor: accent }} onClick={() => navTo('/packages/work/community/index')}>
            <Text style={{ color: accent }}>{svc ? `找${svc.teacherName}对接服务商` : '找服务老师对接'}</Text>
          </View>
        </View>

        {/* 私有化部署（从老板 tab 菜单并入）：企业版意向登记住在企业服务面里，与工商/财税同一受众 */}
        <View className="ent-private" onClick={() => Taro.showToast({ title: '已记录企业版意向', icon: 'none' })}>
          <View className="ent-private-b">
            <Text className="ent-private-t">私有化部署 · 企业版</Text>
            <Text className="ent-private-s">数据本地化、专属模型与团队席位，服务老师会跟进</Text>
          </View>
          <Text className="ent-private-go" style={{ color: accent }}>预约</Text>
        </View>
        <View style={{ height: '32px' }} />
      </View>
    </View>
  );
}
