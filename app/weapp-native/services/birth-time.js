const DEFAULT_BIRTH_TIME = '12:00';

function parts(known, value) {
  if (!known) return { hour: null };
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return { hour: match ? Number(match[1]) : 12, minute: match ? Number(match[2]) : 0 };
}

function valueOf(hour, minute) {
  if (hour === null || hour === undefined) return DEFAULT_BIRTH_TIME;
  const resolvedMinute = minute === null || minute === undefined ? (hour === 0 || hour === 23 ? 30 : 0) : minute;
  return `${String(hour).padStart(2, '0')}:${String(resolvedMinute).padStart(2, '0')}`;
}

module.exports = { DEFAULT_BIRTH_TIME, parts, valueOf };
