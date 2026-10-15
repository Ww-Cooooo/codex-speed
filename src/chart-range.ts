import type { PointView, SampleView } from './contracts';
import { isValidSample } from './statistics.ts';

export type ChartRangeMode = 'auto' | 'hour' | 'today' | 'day' | 'custom';
export interface ChartRangeSelection {
  mode: ChartRangeMode;
  day?: string;
  start?: string;
  end?: string;
}
export interface ChartRangeResult {
  bounds: [number, number];
  points: PointView[];
  average: number | null;
  validCount: number;
  excludedCount: number;
  error: string | null;
  label: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const validTime = (time: number) => Number.isFinite(time) && Number.isFinite(new Date(time).getTime());

function localDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): Date | null {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59) return null;
  // setFullYear avoids Date's special treatment of years 00–99.
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, millisecond);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function parseDay(value?: string): Date | null {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return parts ? localDate(Number(parts[1]), Number(parts[2]), Number(parts[3])) : null;
}

function parseLocalDateTime(value?: string): number | null {
  const parts = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!parts) return null;
  const hour = Number(parts[4]), minute = Number(parts[5]), second = Number(parts[6] ?? 0);
  const millisecond = Number((parts[7] ?? '').padEnd(3, '0'));
  const date = localDate(Number(parts[1]), Number(parts[2]), Number(parts[3]), hour, minute, second, millisecond);
  // Nonexistent local clock times (for example a DST jump) must not roll forward.
  return date && date.getHours() === hour && date.getMinutes() === minute
    && date.getSeconds() === second && date.getMilliseconds() === millisecond ? date.getTime() : null;
}

function fullDayBounds(date: Date): [number, number] {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(0, 0, 0, 0);
  return [start.getTime(), end.getTime()];
}

/** Only automatic range follows the overview period. Explicit ranges filter the
 * supplied conversation/configuration history independently. Calendar days are
 * [start, next midnight); hour/custom and the overview scope include both ends.
 */
export function deriveChartRange(
  samples: readonly SampleView[], selection: ChartRangeSelection,
  scopeBounds: readonly [number, number], now: number,
): ChartRangeResult {
  const fallbackNow = validTime(now) ? now : HOUR;
  const result: ChartRangeResult = {
    bounds: [fallbackNow - HOUR, fallbackNow], points: [], average: null,
    validCount: 0, excludedCount: 0, error: null, label: '图表范围',
  };
  if (!validTime(now)) return { ...result, error: '当前时间不可用' };
  let endExclusive = false;
  switch (selection.mode) {
    case 'auto':
      result.label = '自动范围';
      if (!validTime(scopeBounds[0]) || !validTime(scopeBounds[1]) || scopeBounds[1] < scopeBounds[0]) {
        return { ...result, error: '统计时间范围无效' };
      }
      result.bounds = [scopeBounds[0], scopeBounds[1]];
      break;
    case 'hour':
      result.label = '近 1 小时';
      result.bounds = [now - HOUR, now];
      break;
    case 'today':
      result.label = '今天';
      result.bounds = fullDayBounds(new Date(now));
      endExclusive = true;
      break;
    case 'day': {
      const day = parseDay(selection.day);
      if (!day) return { ...result, error: '请选择有效日期' };
      result.label = `${selection.day} 全天`;
      result.bounds = fullDayBounds(day);
      endExclusive = true;
      break;
    }
    case 'custom': {
      const start = parseLocalDateTime(selection.start), end = parseLocalDateTime(selection.end);
      if (start === null || end === null) return { ...result, error: '请输入有效的开始和结束时间' };
      if (end <= start) return { ...result, error: '结束时间必须晚于开始时间' };
      result.label = `${selection.start!.replace('T', ' ')} — ${selection.end!.replace('T', ' ')}`;
      result.bounds = [start, end];
      break;
    }
    default:
      return { ...result, error: '请选择有效的图表范围' };
  }

  const selected = samples.map((sample) => ({ sample, time: Date.parse(sample.completedAt) }))
    .filter(({ time }) => Number.isFinite(time) && time <= now && time >= result.bounds[0]
      && (endExclusive ? time < result.bounds[1] : time <= result.bounds[1]))
    .sort((a, b) => a.time - b.time);
  let tokens = 0, seconds = 0;
  result.points = selected.map(({ sample }) => {
    const valid = isValidSample(sample);
    if (valid) {
      result.validCount += 1;
      tokens += sample.outputTokens;
      seconds += sample.durationSeconds;
    } else result.excludedCount += 1;
    return { time: sample.completedAt, tps: valid ? sample.tps : null,
      exclusion: valid ? null : sample.exclusion || 'invalid_measurement' };
  });
  result.average = seconds ? tokens / seconds : null;
  if (selection.mode === 'auto' && selected.length) {
    const first = selected[0].time, last = selected.at(-1)!.time;
    const padding = Math.max(MINUTE, (last - first) * 0.05);
    result.bounds = [first - padding, last + padding];
  } else if (result.bounds[0] === result.bounds[1]) {
    result.bounds = [result.bounds[0] - MINUTE, result.bounds[1] + MINUTE];
  }
  return result;
}
