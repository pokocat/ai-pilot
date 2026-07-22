import { memo, useMemo } from 'react';
import { View, Text } from '@tarojs/components';
import './index.scss';

type Block =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'list'; ordered: boolean; items: string[] };

interface Props {
  text: string;
  className?: string;
  inline?: boolean;
  selectable?: boolean;
}

// 流式渲染高频重绘：memo + 按 text 缓存 parseBlocks，避免每个 token 重复全量解析/重建块。
function MarkdownText({ text, className = '', inline = false, selectable = false }: Props) {
  const blocks = useMemo(() => (inline ? [] : parseBlocks(text)), [text, inline]);

  if (inline) {
    const body = selectable ? cleanSelectableInline(text) : renderInline(cleanInline(text));
    return <Text className={`md-inline ${className}`} {...selectProps(selectable)}>{body}</Text>;
  }

  return (
    <View className={`md ${className}`}>
      {blocks.map((block, i) => renderBlock(block, i, selectable))}
    </View>
  );
}

export default memo(MarkdownText);

function renderBlock(block: Block, key: number, selectable: boolean) {
  if (block.type === 'heading') {
    return <Text key={key} className={`md-h md-h${block.level}`} {...selectProps(selectable)}>{selectable ? cleanSelectableInline(block.text) : renderInline(block.text)}</Text>;
  }
  if (block.type === 'quote') {
    return <View key={key} className="md-quote"><Text {...selectProps(selectable)}>{selectable ? cleanSelectableInline(block.text) : renderInline(block.text)}</Text></View>;
  }
  if (block.type === 'code') {
    return <Text key={key} className="md-codeblock" {...selectProps(selectable)}>{block.text}</Text>;
  }
  if (block.type === 'table') {
    return (
      <View key={key} className="md-table">
        {block.rows.map((row, ri) => (
          <View key={ri} className={`md-tr ${ri === 0 ? 'head' : ''}`}>
            {row.map((cell, ci) => (
              <Text key={ci} className="md-td" {...selectProps(selectable)}>
                {selectable ? cleanSelectableInline(cell) : renderInline(cell)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    );
  }
  if (block.type === 'list') {
    return (
      <View key={key} className="md-list">
        {block.items.map((item, i) => (
          <View key={i} className="md-li">
            <Text className="md-marker">{block.ordered ? `${i + 1}.` : '•'}</Text>
            <Text className="md-li-text" {...selectProps(selectable)}>{selectable ? cleanSelectableInline(item) : renderInline(item)}</Text>
          </View>
        ))}
      </View>
    );
  }
  return <Text key={key} className="md-p" {...selectProps(selectable)}>{selectable ? cleanSelectableInline(block.text) : renderInline(block.text)}</Text>;
}

function selectProps(selectable: boolean) {
  // Taro Text 合法长按选择属性是 selectable；userSelect 并非其合法属性，去掉。
  return selectable ? { selectable: true } : {};
}

function parseBlocks(input: string): Block[] {
  const normalized = input.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const lines = normalized.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i += 1; continue; }

    if (line.startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', text: body.join('\n') });
      i += 1;
      continue;
    }

    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length === 1 ? 2 : (Math.min(h[1].length, 3) as 2 | 3), text: cleanInline(h[2]) });
      i += 1;
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      // 表格：逐行按 | 拆列，首行当表头（加粗）；分隔行（---）跳过。不追求完美表格，简单行列呈现。
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const row = lines[i].trim();
        if (!/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(row)) {
          const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => cleanInline(c.trim()));
          rows.push(cells);
        }
        i += 1;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: cleanInline(quote.join(' ')) });
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const items: string[] = [];
      const isOrdered = !!ordered;
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!current) {
          const nextIndex = findNextContentLine(lines, i + 1);
          if (nextIndex >= 0 && matchListLine(lines[nextIndex].trim(), isOrdered)) {
            i = nextIndex;
            continue;
          }
          break;
        }

        const m = matchListLine(current, isOrdered);
        if (!m) break;

        const itemLines = [m[1]];
        i += 1;
        while (i < lines.length) {
          const next = lines[i].trim();
          if (!next || matchListLine(next, isOrdered) || isBlockStart(next)) break;
          itemLines.push(next);
          i += 1;
        }
        items.push(cleanInline(itemLines.join(' ')));
      }
      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i].trim())) {
      para.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: cleanInline(para.join(' ')) });
  }

  return blocks;
}

function findNextContentLine(lines: string[], start: number): number {
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i].trim()) return i;
  }
  return -1;
}

function matchListLine(line: string, ordered: boolean): RegExpExecArray | null {
  return ordered ? /^\d+[.)]\s+(.+)$/.exec(line) : /^[-*]\s+(.+)$/.exec(line);
}

function isBlockStart(line: string): boolean {
  return /^(#{1,3})\s+/.test(line)
    || line.startsWith('```')
    || /^>\s?/.test(line)
    || /^[-*]\s+/.test(line)
    || /^\d+[.)]\s+/.test(line)
    || /^\|.*\|$/.test(line);
}

function cleanInline(text: string): string {
  return text
    // 仅剥「# 标题」式前缀（#后必须有空白）——「##大字强调##」是行内标记，不能误吞。
    .replace(/^#+\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function cleanSelectableInline(text: string): string {
  return cleanInline(text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/!!([^!\n]+)!!/g, '$1')
    .replace(/##([^#\n]+)##/g, '$1');
}

// 行内标记（与服务端 reportHtml 同一套子集）：**加粗** `代码` ==金底高亮== !!朱红警示!! ##大字强调##
function renderInline(text: string) {
  const nodes: JSX.Element[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`]+`|==[^=\n]+==|!![^!\n]+!!|##[^#\n]+##)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(text))) {
    if (match.index > last) nodes.push(<Text key={key++}>{text.slice(last, match.index)}</Text>);
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<Text key={key++} className="md-strong">{token.slice(2, -2)}</Text>);
    } else if (token.startsWith('`')) {
      nodes.push(<Text key={key++} className="md-code">{token.slice(1, -1)}</Text>);
    } else if (token.startsWith('==')) {
      nodes.push(<Text key={key++} className="md-hl">{token.slice(2, -2)}</Text>);
    } else if (token.startsWith('!!')) {
      nodes.push(<Text key={key++} className="md-risk">{token.slice(2, -2)}</Text>);
    } else {
      nodes.push(<Text key={key++} className="md-big">{token.slice(2, -2)}</Text>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(<Text key={key++}>{text.slice(last)}</Text>);
  return nodes.length ? nodes : text;
}
