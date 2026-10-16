import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveTrendDomain, prepareTrendTraces, type TrendTrace} from './linked-trend.ts';
import type {PointView} from './contracts';

const minute = 60_000, now = Date.UTC(2026, 9, 16, 12);
const point = (time: number, tps: number | null = 80, exclusion: string | null = null): PointView => ({time: new Date(time).toISOString(), tps, exclusion});
const trace = (id: string, points: PointView[]): TrendTrace => ({id, name: id, color: '#b9c998', points});
const fallback = [now - 30 * minute, now] as const;

test('shared axes cover independent traces and only trusted TPS sets the vertical scale', () => {
  const traces = [trace('a', [point(now - 20 * minute, 10), point(now - 15 * minute, 9000, 'cancelled')]),
    trace('b', [point(now - 10 * minute, 170), point(now - 9 * minute, null), point(now - 8 * minute, Infinity), point(now - 7 * minute, -5),
      {time: 'invalid', tps: 10_000, exclusion: null}])];
  const before = JSON.stringify(traces), domain = deriveTrendDomain(traces, fallback);
  assert.ok(domain.x[0] <= now - 20 * minute && domain.x[1] >= now - 7 * minute);
  assert.deepEqual(domain.y, [0, 180]);
  assert.equal(JSON.stringify(traces), before);
});

test('one real point has a two-minute axis at either recent-period edge without extrapolating samples', () => {
  for (const time of [fallback[0], now - minute, now]) {
    const traces = [trace('a', [point(time, 80)])], domain = deriveTrendDomain(traces, fallback);
    assert.equal(domain.x[1] - domain.x[0], 2 * minute);
    assert.ok(domain.x[0] >= fallback[0] && domain.x[1] <= fallback[1]);
    assert.deepEqual(domain.y, [60, 100]);
    assert.equal(prepareTrendTraces(traces)[0].series.valid.length, 1);
    assert.deepEqual(prepareTrendTraces(traces)[0].series.bridges, []);
  }
});

test('missing-only and empty scopes retain honest time context and no numeric readings', () => {
  assert.deepEqual(deriveTrendDomain([], fallback), {x: [...fallback], y: [0, 100]});
  const traces = [trace('a', [point(now - 2 * minute, null), point(now - minute, 9000, 'missing_start')])];
  const domain = deriveTrendDomain(traces, fallback);
  assert.deepEqual(domain.y, [0, 100]);
  assert.ok(domain.x[0] <= now - 2 * minute && domain.x[1] >= now - minute);
  assert.deepEqual(prepareTrendTraces(traces)[0].series.valid, []);
});

test('shared preparation cannot bridge a gap across conversations or configurations', () => {
  const result = prepareTrendTraces([
    trace('conversation-a/config-a', [point(now - 4 * minute, 20), point(now - 3 * minute, null)]),
    trace('conversation-a/config-b', [point(now - 2 * minute, 90), point(now - minute, null), point(now, 110)]),
    trace('conversation-b/config-a', [point(now - minute, 40)]),
  ]);
  assert.deepEqual(result.map(item => item.series.bridges.length), [0, 1, 0]);
  assert.deepEqual(result[1].series.bridges[0].map(item => item.tps), [90, 110]);
  assert.deepEqual(result.map(item => item.series.valid.length), [1, 2, 1]);
});

test('full recent intervals remain bounded and high genuine output is never clipped', () => {
  const domain = deriveTrendDomain([trace('a', [point(fallback[0], 350), point(now, 355)])], fallback);
  assert.deepEqual(domain.x, [...fallback]);
  assert.ok(domain.y[0] <= 350 && domain.y[1] >= 355 && domain.y[1] - domain.y[0] >= 40);
});

test('invalid fallback and out-of-bound supplied records keep deterministic finite axes', () => {
  assert.deepEqual(deriveTrendDomain([], [NaN, NaN]), {x: [0, 120_000], y: [0, 100]});
  const earlier = now - 60 * minute;
  const domain = deriveTrendDomain([trace('a', [point(earlier, 0)])], fallback);
  assert.ok(domain.x[0] <= earlier && domain.x[1] >= earlier);
  assert.deepEqual(domain.y, [0, 40]);
});
