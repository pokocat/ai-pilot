import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { MEMORY_SOURCES } from '../../../data/operatingSystem';
import { navTo } from '../../../services/nav';
import './index.scss';

// 人脉圈与持续记忆（新设计稿 relationships / memorySourceProfile）——把每天真实发生的事变成可用的档案：
// 关系、承诺、决定、风险先进「待校对」，你确认后才写入长期档案并回写战局。
// 现状口径：持续记忆还没有后端数据源接入，所以本页是「未开通」态——
//   · 人脉圈三个计数是真零，不摆 286 张卡片这种示例数字；
//   · 五个来源只讲「开通后产出什么」和「读取范围」，价格一律不写在代码里（定价归运营后台）；
//   · 开通动线走方案与权益页，导入动线走服务老师。
export default function Relations() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const svc = s.me()?.service ?? null;
  const [open, setOpen] = useState(MEMORY_SOURCES[0].key);

  return (
    <View className={`page rel-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="人脉圈与持续记忆" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="rel-hero card">
          <Text className="kicker">Continuous Memory</Text>
          <Text className="h1">让军师理解每天真实发生的事</Text>
          <Text className="rel-p">
            持续记忆不是把聊天记录交给 AI，而是把你主动选中的资料整理成一版待你校对的记忆：
            关系、承诺、决定和风险先进待确认区，你点确认后才写入长期档案，并回写战局判断。
          </Text>
        </View>

        {/* 人脉圈概览：真零态。有了后端再接真实计数，不在这里编数字。 */}
        <View className="rel-stats">
          {[['人脉卡片', 0], ['待跟进', 0], ['关系群组', 0]].map(([l, v]) => (
            <View key={l as string} className="rel-stat card">
              <Text className="rel-stat-v serif">{v as number}</Text>
              <Text className="rel-stat-l">{l as string}</Text>
            </View>
          ))}
        </View>
        <View className="rel-empty card">
          <Text className="rel-empty-t">还没有人脉数据</Text>
          <Text className="rel-empty-d">
            先连接一个记忆来源，再由你校对联系人、组织、关系来源和跟进事项。校对之前，军师不会用它下判断。
          </Text>
        </View>

        <View className="sec-head">
          <Text className="sec-title">五个记忆来源</Text>
          <Text className="sec-more">点开看读取范围</Text>
        </View>

        {MEMORY_SOURCES.map((src) => {
          const on = open === src.key;
          return (
            <View key={src.key} className={`rel-src card ${on ? 'is-open' : ''}`} onClick={() => setOpen(on ? '' : src.key)}>
              <View className="rel-src-top">
                <View className="rel-src-b">
                  <Text className="rel-src-t serif">{src.title}</Text>
                  <Text className="rel-src-d">{src.desc}</Text>
                </View>
                <Text className="rel-src-st" style={{ color: accent }}>{on ? '收起' : '未开通'}</Text>
              </View>

              {on ? (
                <View className="rel-src-detail">
                  <Text className="rel-dk">开通后产出</Text>
                  <View className="rel-vgrid">
                    {src.values.map(([t, d]) => (
                      <View key={t} className="rel-vcell">
                        <Text className="rel-vcell-t">{t}</Text>
                        <Text className="rel-vcell-d">{d}</Text>
                      </View>
                    ))}
                  </View>

                  <Text className="rel-dk">读取范围</Text>
                  {src.scopes.map(([t, d]) => (
                    <View key={t} className="rel-scope">
                      <Text className="rel-scope-t">{t}</Text>
                      <Text className="rel-scope-d">{d}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}

        {/* 隐私边界：这是产品硬口径，必须写在页面上 */}
        <View className="rel-privacy card">
          <View className="rel-privacy-ic" style={{ background: 'var(--accent-soft)' }}>
            <Icon name="shield" size={16} color={accent} />
          </View>
          <View className="rel-privacy-b">
            <Text className="rel-privacy-t">数据原则</Text>
            <Text className="rel-privacy-d">
              只处理你主动导入或授权的数据。每个来源可以单独暂停、撤销和删除；原文保留在私密资料库。
              人脉卡片只用于你自己的关系管理和军师执行，不会自动给联系人发送任何消息。
            </Text>
          </View>
        </View>

        <View className="rel-actions">
          <View className="rel-act rel-act-main" style={{ background: accent }} onClick={() => navTo('/packages/work/plans/index')}>
            <Text>查看开通方式</Text>
            <Icon name="arrow" size={15} color="#FBFAF6" />
          </View>
          <View className="rel-act" style={{ borderColor: accent }} onClick={() => (svc ? navTo('/packages/work/community/index') : Taro.showToast({ title: '服务老师分配后开放', icon: 'none' }))}>
            <Text style={{ color: accent }}>{svc ? `让${svc.teacherName}协助导入` : '服务老师分配后协助导入'}</Text>
          </View>
        </View>
        <View style={{ height: '32px' }} />
      </View>
    </View>
  );
}
