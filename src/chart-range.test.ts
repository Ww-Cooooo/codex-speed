import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveChartRange, deriveRecentChartRange, RECENT_CHART_WINDOW } from './chart-range.ts';
import type { SampleView } from './contracts';

const minute = 60_000;
const now = new Date(2026, 9, 13, 12).getTime();
const todayStart = new Date(2026, 9, 13).getTime();
const sample = (time: number, overrides: Partial<SampleView> = {}): SampleView => ({
  profileId: 'a'.repeat(24), conversationId: 'b'.repeat(64),
  completedAt: new Date(time).toISOString(), tps: 10, outputTokens: 100,
  durationSeconds: 10, exclusion: null, ...overrides,
});

test('automatic chart range follows the scope but fits actual output and excluded points', () => {
  const first = now - 20 * minute, last = now - 10 * minute;
  const data = [sample(last, { tps: null, exclusion: 'cancelled' }), sample(first), sample(todayStart - 1),
    sample(now + 1), sample(now, { completedAt: 'invalid-time' })];
  const before = JSON.stringify(data);
  const result = deriveChartRange(data, { mode: 'auto' }, [todayStart, now], now);
  assert.equal(result.error, null);
  assert.equal(result.points.length, 2);
  assert.equal(result.points[0].time, new Date(first).toISOString());
  assert.equal(result.points[1].tps, null);
  assert.equal(result.points[1].exclusion, 'cancelled');
  assert.deepEqual(result.bounds, [first - minute, last + minute]);
  assert.equal(result.validCount, 1);
  assert.equal(result.excludedCount, 1);
  assert.equal(JSON.stringify(data), before);
  const one = deriveChartRange([sample(last)], { mode: 'auto' }, [todayStart, now], now);
  assert.deepEqual(one.bounds, [last - minute, last + minute]);
  assert.equal(one.points.length, 1);
});

test('hour range includes its endpoints and weights only trusted measured outputs', () => {
  const start = now - 60 * minute;
  const result = deriveChartRange([
    sample(start - 1), sample(start, { tps: 100, outputTokens: 100, durationSeconds: 1 }),
    sample(now, { tps: 100 / 9, outputTokens: 100, durationSeconds: 9 }),
    sample(now - 1, { tps: 9000, outputTokens: 9000, durationSeconds: 1, exclusion: 'cancelled' }),
    sample(now - 2, { durationSeconds: 0 }), sample(now + 1),
  ], { mode: 'hour' }, [now, now], now);
  assert.deepEqual(result.bounds, [start, now]);
  assert.equal(result.points.length, 4);
  assert.equal(result.validCount, 2);
  assert.equal(result.excludedCount, 2);
  assert.equal(result.average, 20);
});

test('today and selected calendar days retain full local-day axes with a half-open end', () => {
  const nextDay = new Date(2026, 9, 14).getTime();
  const current = deriveChartRange([sample(todayStart), sample(todayStart - 1), sample(now + 1)],
    { mode: 'today' }, [0, 1], now);
  assert.deepEqual(current.bounds, [todayStart, nextDay]);
  assert.equal(current.points.length, 1);
  const monthEnd = new Date(2026, 8, 30).getTime(), nextMonth = new Date(2026, 9, 1).getTime();
  const past = deriveChartRange([sample(monthEnd - 1), sample(monthEnd), sample(nextMonth - 1), sample(nextMonth)],
    { mode: 'day', day: '2026-09-30' }, [todayStart, now], now);
  assert.deepEqual(past.bounds, [monthEnd, nextMonth]);
  assert.equal(past.points.length, 2);
});

test('custom local datetime ranges cross midnight and include both exact endpoints', () => {
  const start = new Date(2026, 8, 30, 23, 59).getTime(), end = new Date(2026, 9, 1, 0, 1).getTime();
  const result = deriveChartRange([sample(start - 1), sample(start), sample(end), sample(end + 1)],
    { mode: 'custom', start: '2026-09-30T23:59', end: '2026-10-01T00:01' }, [todayStart, now], now);
  assert.equal(result.error, null);
  assert.deepEqual(result.bounds, [start, end]);
  assert.equal(result.points.length, 2);
  assert.match(result.label, /2026-09-30 23:59/);
});

test('invalid local dates and reversed ranges return errors without applying rollover or inventing points', () => {
  for (const day of ['2026-02-30', '2026-13-01', '2026-2-01', '0000-01-01', '']) {
    const result = deriveChartRange([], { mode: 'day', day }, [todayStart, now], now);
    assert.ok(result.error);
    assert.deepEqual(result.points, []);
  }
  for (const [start, end] of [
    ['2026-02-30T10:00', '2026-03-01T12:00'],
    ['2026-10-13T24:00', '2026-10-14T12:00'],
    ['2026-10-13T10:60', '2026-10-13T12:00'],
    ['2026-10-13T10:00Z', '2026-10-13T12:00'],
    ['2026-10-13T10:00', '2026-10-13T10:00'],
    ['2026-10-13T12:00', '2026-10-13T10:00'],
  ]) assert.ok(deriveChartRange([], { mode: 'custom', start, end }, [todayStart, now], now).error);
  assert.ok(deriveChartRange([], { mode: 'auto' }, [now, todayStart], now).error);
  assert.ok(deriveChartRange([], { mode: 'today' }, [todayStart, now], NaN).error);
  assert.equal(deriveChartRange([], { mode: 'day', day: '2024-02-29' }, [todayStart, now], now).error, null);
});

test('empty scopes and exclusion-only ranges do not fabricate measurements', () => {
  const empty = deriveChartRange([], { mode: 'auto' }, [todayStart, now], now);
  assert.deepEqual(empty.bounds, [todayStart, now]);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.average, null);
  assert.equal(empty.validCount, 0);
  assert.equal(empty.excludedCount, 0);
  const excluded = deriveChartRange([sample(now - minute, { durationSeconds: NaN }),
    sample(now - 2 * minute, { tps: null })], { mode: 'auto' }, [todayStart, now], now);
  assert.equal(excluded.points.length, 2);
  assert.ok(excluded.points.every((point) => point.tps === null));
  assert.equal(excluded.average, null);
  assert.equal(excluded.excludedCount, 2);
});

test('local calendar days follow DST rather than fixed 24-hour blocks, and missing clock times are rejected', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const localNow = new Date(2026, 2, 10, 12).getTime();
    const result = deriveChartRange([], { mode: 'day', day: '2026-03-08' }, [0, localNow], localNow);
    assert.equal(result.error, null);
    assert.equal(result.bounds[1] - result.bounds[0], 23 * 60 * minute);
    assert.ok(deriveChartRange([], { mode: 'custom', start: '2026-03-08T02:30', end: '2026-03-08T04:00' },
      [0, localNow], localNow).error);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('compact recent range filters only the last thirty minutes and fits their real output', () => {
  const first = now - 20 * minute, last = now - 10 * minute;
  const result = deriveRecentChartRange([sample(now - RECENT_CHART_WINDOW - 1), sample(first),
    sample(last, { tps: null, exclusion: 'missing_start' }), sample(now + 1)], now);
  assert.deepEqual(result.bounds, [first - minute, last + minute]);
  assert.equal(result.points.length, 2);
  assert.equal(result.validCount, 1);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.average, 10);
});

test('compact recent range never refills from stale history or fabricates an empty reading', () => {
  const result = deriveRecentChartRange([sample(now - RECENT_CHART_WINDOW - 1)], now);
  assert.deepEqual(result.bounds, [now - RECENT_CHART_WINDOW, now]);
  assert.deepEqual(result.points, []);
  assert.equal(result.average, null);
});

test('compact ranges stay inside thirty minutes and retain a readable two-minute axis at either edge', () => {
  for (const time of [now - RECENT_CHART_WINDOW, now - minute, now]) {
    const result = deriveRecentChartRange([sample(time)], now);
    assert.equal(result.bounds[1] - result.bounds[0], 2 * minute);
    assert.ok(result.bounds[0] >= now - RECENT_CHART_WINDOW);
    assert.ok(result.bounds[1] <= now);
    assert.equal(result.points.length, 1);
  }
  const full = deriveRecentChartRange([sample(now - RECENT_CHART_WINDOW), sample(now)], now);
  assert.deepEqual(full.bounds, [now - RECENT_CHART_WINDOW, now]);
});

test('compact recent ranges cross midnight and retain missing-only records without a mean', () => {
  const midnight = new Date(2026, 9, 14).getTime();
  const result = deriveRecentChartRange([sample(midnight - minute, { tps: null }),
    sample(midnight + minute, { exclusion: 'cancelled' })], midnight + 2 * minute);
  assert.equal(result.points.length, 2);
  assert.equal(result.validCount, 0);
  assert.equal(result.excludedCount, 2);
  assert.equal(result.average, null);
  assert.ok(deriveRecentChartRange([], NaN).error);
});
