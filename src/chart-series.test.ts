import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareChartSeries } from './chart-series.ts';
import type { PointView } from './contracts';

const point = (time: number, tps: number | null = 10, exclusion: string | null = null): PointView => ({ time: new Date(time).toISOString(), tps, exclusion });

test('consecutive trusted readings make one solid run with no missing-data bridge', () => {
  const input = [point(3000, 30), point(1000), point(2000, 20)];
  const before = JSON.stringify(input);
  const result = prepareChartSeries(input);
  assert.deepEqual(result.segments, [[{ time: 1000, tps: 10 }, { time: 2000, tps: 20 }, { time: 3000, tps: 30 }]]);
  assert.deepEqual(result.bridges, []);
  assert.deepEqual(result.gaps, []);
  assert.equal(JSON.stringify(input), before);
});

test('missing records create only a bridge between their two actual trusted endpoints', () => {
  const result = prepareChartSeries([point(1000), point(2000, null), point(3000, 900, 'cancelled'), point(4000, 40), point(5000, 50)]);
  assert.deepEqual(result.segments.map(run => run.length), [1, 2]);
  assert.deepEqual(result.bridges, [[{ time: 1000, tps: 10 }, { time: 4000, tps: 40 }]]);
  assert.deepEqual(result.gaps, [2000, 3000]);
  assert.deepEqual(result.valid.map(reading => reading.tps), [10, 40, 50]);
});

test('leading or trailing missing records and single readings never extrapolate', () => {
  for (const input of [[], [point(1000)], [point(1000, null), point(2000)], [point(1000), point(2000, null)], [point(1000, null), point(2000, null)]]) {
    assert.deepEqual(prepareChartSeries(input).bridges, []);
  }
});

test('invalid numeric readings become missing, invalid times are not drawn, and zero is real', () => {
  const result = prepareChartSeries([point(1000, 0), point(2000, NaN), point(3000, -1), point(4000, Infinity), point(5000, 50), { time: 'bad', tps: 90, exclusion: null }]);
  assert.deepEqual(result.valid, [{ time: 1000, tps: 0 }, { time: 5000, tps: 50 }]);
  assert.equal(result.bridges.length, 1);
  assert.deepEqual(result.gaps, [2000, 3000, 4000]);
});
