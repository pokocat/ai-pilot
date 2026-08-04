import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { ARCHITECTURE_TRIGGERS, ARCHITECTURE_SCOPE, ARCHITECTURE_PATHS } from '../../../data/operatingSystem';
import { navTo, switchTo } from '../../../services/nav';
import './index.scss';

// 公司与事业架构（新设计稿 architecture）——多主体经营的长期版图。
// 设计稿的关键口径：**这不是默认功能**。总军师在诊断中识别到多主体经营、新事业承接和权责关系需要长期
// 管理时才建议建立；用户认可后才在「我的」增加长期入口，并把整理任务同步到「执行」。
// 后端还没有版图建模，所以本页是「建议 + 建立入口」态：讲清为什么触发、建立后管理什么、和现有军师的关系，
// 再把「要不要建」这个判断交回对话——不预置 4 家主体那种示例数据。
export default function Architecture() {
  const s = useStore();
  const accent = s.color().vars['--accent'];

  // 建立版图这件事本身要先过军师诊断：带一句开场进对话，而不是在这里点一下就「已建立」。
  // switchTo 带防重入锁，被锁住时返回 false——那种情况下别再弹提示，否则用户看到提示但页面没动。
  const askAdvisor = () => {
    if (switchTo('/pages/sessions/index')) {
      Taro.showToast({ title: '跟军师说清你有几家主体和几条事业', icon: 'none', duration: 2200 });
    }
  };

  return (
    <View className={`page arch-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="公司与事业架构" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="arch-hero card">
          <Text className="kicker">Strategy Report · 体系建设建议</Text>
          <Text className="h1">先把事业理清，再谈主体</Text>
          <Text className="arch-quote">不是先注册更多公司，而是先把事业、主体和实际控制关系理清。</Text>
          <Text className="arch-p">
            这不是默认功能。只有当军师在诊断里识别到多主体经营、新事业承接和权责关系需要长期管理，
            才建议建立企业版图；建立之后它会持续维护，而不是一次性画张图。
          </Text>
        </View>

        <View className="sec-head">
          <Text className="sec-title">什么情况下需要</Text>
          <Text className="sec-more">命中一条就值得建</Text>
        </View>
        <View className="arch-list card">
          {ARCHITECTURE_TRIGGERS.map((t, i) => (
            <View key={t} className="arch-row">
              <Text className="arch-row-i serif" style={{ background: 'var(--accent-soft)', color: accent }}>{i + 1}</Text>
              <Text className="arch-row-t">{t}</Text>
            </View>
          ))}
        </View>

        <View className="sec-head">
          <Text className="sec-title">建立后管理什么</Text>
          <Text className="sec-more">四类长期关系</Text>
        </View>
        <View className="arch-grid">
          {ARCHITECTURE_SCOPE.map(([t, d]) => (
            <View key={t} className="arch-cell card">
              <Text className="arch-cell-t">{t}</Text>
              <Text className="arch-cell-d">{d}</Text>
            </View>
          ))}
        </View>

        <View className="sec-head">
          <Text className="sec-title">两条起步路径</Text>
          <Text className="sec-more">与军师确认后开始</Text>
        </View>
        {ARCHITECTURE_PATHS.map(([t, d], i) => (
          <View key={t} className="arch-path card" onClick={askAdvisor}>
            <View className="arch-path-ic" style={{ background: 'var(--accent-soft)' }}>
              <Icon name={i === 0 ? 'layers' : 'plus'} size={16} color={accent} />
            </View>
            <View className="arch-path-b">
              <Text className="arch-path-t">{t}</Text>
              <Text className="arch-path-d">{d}</Text>
            </View>
            <Text className="arch-path-go">›</Text>
          </View>
        ))}

        {/* 与现有军师的关系：不改动既有动线，这一条是设计稿明确要求写出来的 */}
        <View className="arch-note card">
          <Text className="arch-note-t">和现在的用法有什么变化</Text>
          <Text className="arch-note-d">
            对话诊断、战略报告、军令、执行和复盘都不变。只有你认可这份建议之后，系统才会把版图作为长期入口维护，
            并把当前的整理任务同步到执行页。
          </Text>
          <Text className="arch-note-d arch-note-warn">
            敏感账号只保存账号归属、保管人和密码库引用，不把明文密码交给 AI。
          </Text>
        </View>

        <View className="arch-actions">
          <View className="arch-act arch-act-main" style={{ background: accent }} onClick={askAdvisor}>
            <Text>跟军师确认要不要建</Text>
            <Icon name="send" size={15} color="#FBFAF6" />
          </View>
          <View className="arch-act" style={{ borderColor: accent }} onClick={() => navTo('/packages/work/enterprise/index')}>
            <Text style={{ color: accent }}>看企业服务办理台</Text>
          </View>
        </View>
        <View style={{ height: '32px' }} />
      </View>
    </View>
  );
}
