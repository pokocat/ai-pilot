import { View } from '@tarojs/components';
import { useRouter } from '@tarojs/taro';
import ChatView from '../../components/ChatView';
import { useStore } from '../../hooks/useStore';
import './index.scss';

// 对话页 —— 薄壳：读路由参数 → 渲染共享 ChatView（专业军师线程 / 历史会话 / 三势研判入口）。
// 对话核心已抽到 components/ChatView；本页只负责页面外壳与参数映射。
export default function Chat() {
  const s = useStore();
  const router = useRouter();
  const p = router.params as Record<string, string>;

  return (
    <View className={`page chat ${s.themeClass()}`}>
      <ChatView
        agentKey={p.agentKey}
        sessionId={p.sessionId}
        continueThread={p.continue === '1'}
        fresh={p.fresh === '1'}
        prefillSend={p.send ? decodeURIComponent(p.send) : undefined}
        projectId={p.projectId}
        forceTag={p.force ? decodeURIComponent(p.force) : ''}
      />
    </View>
  );
}
