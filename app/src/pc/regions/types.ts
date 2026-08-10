import type { NavGroup } from '../ListPane';
import type { BarAction } from '../Chrome';
import type { PcState } from '../state';

/**
 * 一个「区」= 列表栏内容 + 顶栏 + 主工作区内容。
 * 五个区（问策/沙盘/点兵/锦囊/主公）各实现一份，Shell 只按当前 tab 取用。
 */
export interface Region {
  /** 列表栏抬头：水印字、小字、大标题 */
  head: { glyph: string; kicker: string; title: string };
  /** 列表栏的分区导航（问策区返回 undefined，用自己的线程列表） */
  useGroups?: (st: PcState) => NavGroup[];
  /** 顶栏 */
  useBar: (st: PcState) => { title: string; sub?: string; actions?: BarAction[] };
  /** 主工作区 */
  Main: (props: { st: PcState }) => JSX.Element;
  /** 问策区专用：列表栏自定义内容（线程列表） */
  ListBody?: (props: { st: PcState }) => JSX.Element;
}
