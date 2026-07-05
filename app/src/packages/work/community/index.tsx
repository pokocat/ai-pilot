import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { COMMUNITY_STEPS } from '../../../data/operatingSystem';
import './index.scss';

// 军师社群：注册后按身份、城市、方向分班，配服务老师陪跑。
// 分班与服务老师由运营侧分配（能力接入中），本页先亮清楚服务关系与入群动线。
export default function Community() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const me = s.me();

  return (
    <View className={`page community-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="军师社群" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="cm-hero card">
          <Text className="kicker">Community</Text>
          <Text className="h1">军师社群</Text>
          <Text className="cm-p">让决策有章法，让增长有胜算。完成注册后，会根据你的身份、城市和方向分配班级与服务老师，方案提醒、班级任务和复盘通知统一同步。</Text>
        </View>

        <View className="class-card card">
          <View className="class-top">
            <View>
              <Text className="class-k">我的班级</Text>
              <Text className="class-t serif">{me?.user.name ? `${me.user.name} · 待分班` : '登录后分配班级'}</Text>
            </View>
            <Text className="class-st" style={{ color: accent }}>分班准备中</Text>
          </View>
          <Text className="class-d">档案越完整，分班越精准。先完善企业档案与经营方向，运营确认后即分配班级与服务老师。</Text>
          <View className="class-btn" style={{ borderColor: accent }} onClick={() => Taro.navigateTo({ url: '/pages/brief/index' })}>
            <Text style={{ color: accent }}>完善我的档案 ›</Text>
          </View>
        </View>

        <View className="sec-head">
          <Text className="sec-title">三步完成入群</Text>
          <Text className="sec-more">服务老师会协助确认</Text>
        </View>
        <View className="steps card">
          {COMMUNITY_STEPS.map(([t, d], i) => (
            <View key={t} className="step">
              <View className="step-no" style={{ background: i === 0 ? accent : 'var(--surface-2)', color: i === 0 ? '#FBFAF6' : 'var(--ink-3)' }}>
                <Text>{i + 1}</Text>
              </View>
              <View className="step-b">
                <Text className="step-t">{t}</Text>
                <Text className="step-d">{d}</Text>
              </View>
            </View>
          ))}
        </View>

        <View className="teacher-card card">
          <View className="teacher-av" style={{ background: 'var(--accent-soft)' }}>
            <Icon name="user" size={20} color={accent} />
          </View>
          <View className="teacher-b">
            <Text className="teacher-name">服务老师 · 待分配</Text>
            <Text className="teacher-role">分班完成后，这里会显示服务老师与班级二维码</Text>
          </View>
        </View>

        <View className="cm-submit" style={{ background: accent }} onClick={() => Taro.switchTab({ url: '/pages/sessions/index' })}>
          <Text>先进军师参谋室</Text>
          <Icon name="send" size={16} color="#FBFAF6" />
        </View>
        <View style={{ height: '32px' }} />
      </View>
    </View>
  );
}
