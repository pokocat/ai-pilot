// v5 起用户端改收准确钟表时间。新表单统一复用以下 helpers；v6 不做真太阳时换算，
// 并固定 23:00–23:59 为第二天子时，防止各入口再次漂移。
export const DEFAULT_BIRTH_TIME = '12:00';

export function birthTimeParts(known: boolean, value: string): { hour: number | null; minute?: number } {
  if (!known) return { hour: null };
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = match ? Number(match[1]) : 12;
  const minute = match ? Number(match[2]) : 0;
  return { hour, minute };
}

export function birthTimeValue(hour: number | null | undefined, minute: number | null | undefined): string {
  if (hour == null) return DEFAULT_BIRTH_TIME;
  // 旧版只记时辰档位：子正/子初各是半时辰，代表值取中点；其余 hour 本来就是两小时档位中点。
  const resolvedMinute = minute == null ? (hour === 0 || hour === 23 ? 30 : 0) : minute;
  return `${String(hour).padStart(2, '0')}:${String(resolvedMinute).padStart(2, '0')}`;
}
