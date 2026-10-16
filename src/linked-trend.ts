import {prepareChartSeries} from './chart-series.ts';
import type {PointView} from './contracts';

export type TrendTrace = {id: string; name: string; color: string; points: PointView[]};
export type TrendDomain = {x: [number, number]; y: [number, number]};

/** Keep each conversation/configuration independent: a missing reading in one
 * trace must never connect to an output belonging to another trace. */
export function prepareTrendTraces(traces: readonly TrendTrace[]) {
  return traces.map(trace => ({...trace, series: prepareChartSeries(trace.points)}));
}

/** The caller filters history. This function only chooses a shared readable
 * axis; it never introduces a reading or changes a weighted statistic. */
export function deriveTrendDomain(traces: readonly TrendTrace[], fallbackBounds: readonly [number, number]): TrendDomain {
  const prepared = prepareTrendTraces(traces);
  let first = Infinity, last = -Infinity, low = Infinity, high = -Infinity;
  for (const {series} of prepared) {
    // Missing records retain their actual position, including a missing tail.
    for (const time of series.times) {first = Math.min(first, time); last = Math.max(last, time);}
    for (const point of series.valid) {low = Math.min(low, point.tps); high = Math.max(high, point.tps);}
  }
  const fallback: [number, number] = Number.isFinite(fallbackBounds[0]) && Number.isFinite(fallbackBounds[1])
    && fallbackBounds[1] > fallbackBounds[0] ? [...fallbackBounds] : [0, 120_000];
  let x: [number, number] = fallback;
  if (Number.isFinite(first)) {
    const padding = Math.max(60_000, (last - first) * 0.055);
    x = [first - padding, last + padding];
    // Keep a recent view inside its declared period when all supplied records
    // belong there. Shorter explicit periods cannot cap the two-minute minimum.
    if (first >= fallback[0] && last <= fallback[1] && fallback[1] - fallback[0] >= 120_000) {
      x = [Math.max(fallback[0], x[0]), Math.min(fallback[1], x[1])];
      if (x[1] - x[0] < 120_000) {
        x[0] = Math.max(fallback[0], Math.min(x[0], fallback[1] - 120_000));
        x[1] = x[0] + 120_000;
      }
    }
  }
  const yLow = Number.isFinite(low) ? Math.max(0, Math.floor((low - 8) / 20) * 20) : 0;
  const yHigh = Number.isFinite(high) ? Math.max(yLow + 40, Math.ceil((high + 8) / 20) * 20) : 100;
  return {x, y: [yLow, yHigh]};
}
