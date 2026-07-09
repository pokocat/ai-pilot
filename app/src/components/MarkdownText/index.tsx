import { View, Text } from '@tarojs/components';
import './index.scss';

type Block =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] };

interface Props {
  text: string;
  className?: string;
  inline?: boolean;
  selectable?: boolean;
}

export default function MarkdownText({ text, className = '', inline = false, selectable = false }: Props) {
  if (inline) {
    const body = selectable ? cleanSelectableInline(text) : renderInline(cleanInline(text));
    return <Text className={`md-inline ${className}`} {...selectProps(selectable)}>{body}</Text>;
  }

  const blocks = parseBlocks(text);
  return (
    <View className={`md ${className}`}>
      {blocks.map((block, i) => renderBlock(block, i, selectable))}
    </View>
  );
}

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
  return selectable ? { selectable: true, userSelect: true } : {};
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
      const table: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const row = lines[i].trim();
        if (!/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(row)) table.push(row);
        i += 1;
      }
      blocks.push({ type: 'code', text: table.join('\n') });
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
    .replace(/^#+\s*/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function cleanSelectableInline(text: string): string {
  return cleanInline(text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function renderInline(text: string) {
  const nodes: JSX.Element[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(text))) {
    if (match.index > last) nodes.push(<Text key={key++}>{text.slice(last, match.index)}</Text>);
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<Text key={key++} className="md-strong">{token.slice(2, -2)}</Text>);
    } else {
      nodes.push(<Text key={key++} className="md-code">{token.slice(1, -1)}</Text>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(<Text key={key++}>{text.slice(last)}</Text>);
  return nodes.length ? nodes : text;
}
