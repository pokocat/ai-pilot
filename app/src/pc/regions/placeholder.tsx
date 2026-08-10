// Phase 0 骨架期的区占位。每个区在后续 Phase 里换成真实实现，
// 换的时候只改 regions/index.ts 的映射，Shell 不动。

import { Empty } from '../Chrome';
import type { PcState } from '../state';

export function makePlaceholder(glyph: string, title: string, sub: string) {
  return function Placeholder(_props: { st: PcState }) {
    return (
      <div className="pc-page">
        <Empty glyph={glyph} title={title} sub={sub} />
      </div>
    );
  };
}
