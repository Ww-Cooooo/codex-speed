import type { PointView } from './contracts';

export interface PlotPoint { time: number; tps: number }

/** Solid runs contain only consecutive trusted readings. A dashed bridge links
 * two real readings separated by missing records, without inventing a reading
 * or an outage duration at those missing times.
 */
export function prepareChartSeries(points: readonly PointView[]) {
  const sorted = points.map(point => ({
    time: Date.parse(point.time),
    tps: typeof point.tps === 'number' && Number.isFinite(point.tps) && point.tps >= 0 && !point.exclusion ? point.tps : null,
  })).filter(point => Number.isFinite(point.time)).sort((a, b) => a.time - b.time);
  const segments: PlotPoint[][] = [], bridges: [PlotPoint, PlotPoint][] = [];
  const valid: PlotPoint[] = [], gaps: number[] = [];
  let segment: PlotPoint[] = [], previous: PlotPoint | undefined, missing = false;
  for (const point of sorted) {
    if (point.tps === null) {
      gaps.push(point.time);
      if (segment.length) segments.push(segment);
      segment = [];
      missing = true;
      continue;
    }
    const reading = { time: point.time, tps: point.tps };
    if (missing && previous) bridges.push([previous, reading]);
    valid.push(reading);
    segment.push(reading);
    previous = reading;
    missing = false;
  }
  if (segment.length) segments.push(segment);
  return { valid, gaps, segments, bridges, times: sorted.map(point => point.time) };
}
