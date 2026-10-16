import {useEffect, useMemo, useRef, useState} from 'react';
import {Chart, type G2Spec, type Mark} from '@antv/g2';
import {Renderer} from '@antv/g-svg';
import {Bound, CanvasSpace, Pt} from 'pts';
import type {ChartRangeResult} from './chart-range';
import {prepareChartSeries, type PlotPoint} from './chart-series';
import type {PointView} from './contracts';
import './production-pulse-chart.css';

type Prepared = {
  bounds: [number, number]; valid: PlotPoint[]; segments: PlotPoint[][]; bridges: [PlotPoint, PlotPoint][];
  average: number | null; excluded: number; detail: boolean; height: number;
  unavailable: boolean; error: string | null;
};
const tone = {ink: '#aaa59b', grid: '#3b3933', line: '#e6d87c', paper: '#24241f', mean: '#8c8978'};
const font = 'Space Grotesk, Noto Sans SC, sans-serif';
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (time: number, seconds = false) => {
  const date = new Date(time);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`;
};
const dateLabel = (time: number) => {
  const date = new Date(time);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};
const absoluteTime = (time: number) => new Date(time).toLocaleString('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const rangeCaption = ([start, end]: readonly [number, number]) => {
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
  return `${dateLabel(start)} ${clock(start)}–${sameDay ? '' : `${dateLabel(end)} `}${clock(end)}`;
};
const pointsKey = (points: readonly PointView[]) => JSON.stringify(points.map(p => [p.time, p.tps, p.exclusion]));

function prepare(result: ChartRangeResult, detail: boolean, height: number, unavailable: boolean): Prepared {
  const series = prepareChartSeries(unavailable ? [] : result.points);
  return {bounds: result.bounds, valid: series.valid, segments: series.segments, bridges: series.bridges,
    average: unavailable ? null : result.average, excluded: unavailable ? 0 : result.excludedCount,
    detail, height, unavailable, error: result.error};
}

function yDomain(data: Prepared): [number, number] {
  if (!data.valid.length) return [0, 130];
  const values = data.valid.map(point => point.tps);
  if (data.average !== null) values.push(data.average);
  const max = Math.max(...values);
  // Overview remains comparable up to 130 TPS, but a genuine faster reading
  // must remain visible rather than be clipped by the reference's sample scale.
  if (!data.detail) return [0, Math.max(130, Math.ceil(max * 1.05 / 10) * 10)];
  const min = Math.min(...values), padding = Math.max(6, (max - min) * 0.18);
  const lower = Math.max(0, Math.floor((min - padding) / 10) * 10);
  return [lower, Math.max(lower + 10, Math.ceil((max + padding) / 10) * 10)];
}

function options(data: Prepared, width: number, height: number): G2Spec {
  const [start, end] = data.bounds, domain = yDomain(data), detail = data.detail;
  const span = end - start, seconds = span <= 300_000;
  const dateTicks = span >= 86_400_000;
  const tickLabel = (value: unknown) => dateTicks ? dateLabel(Number(value)) : clock(Number(value), seconds);
  const xTicks = width < 340 ? [start, end] : [start, start + span / 2, end];
  const pointSize = data.valid.length > 200 ? 1.3 : data.valid.length > 60 ? 1.8 : data.valid.length > 12 ? 2.4 : detail ? 3.2 : 2.4;
  const children: Mark[] = [];
  if (data.average !== null) children.push({
    type: 'line', key: 'range-mean', data: [{time: start, tps: data.average}, {time: end, tps: data.average}],
    encode: {x: 'time', y: 'tps'}, style: {stroke: tone.mean, lineDash: [3, 4], lineWidth: 1}, tooltip: false, animate: false,
  });
  for (const [index, segment] of data.segments.entries()) if (segment.length > 1) children.push({
    type: 'line', key: `valid-run-${index}`, data: segment, encode: {x: 'time', y: 'tps'},
    style: {stroke: tone.line, lineWidth: detail ? 2.2 : 1.8}, tooltip: false, animate: false,
  });
  for (const [index, bridge] of data.bridges.entries()) children.push({
    type: 'line', key: `missing-reading-bridge-${index}`, data: bridge, encode: {x: 'time', y: 'tps'},
    style: {stroke: tone.line, strokeOpacity: 0.65, lineDash: [2, 3], lineWidth: 1}, tooltip: false, animate: false,
  });
  children.push({type: 'point', key: 'completed-readings', data: data.valid,
    encode: {x: 'time', y: 'tps', size: pointSize},
    style: {fill: tone.line, stroke: tone.paper, lineWidth: detail ? 1.1 : 0.8},
    tooltip: {title: (point: PlotPoint) => absoluteTime(point.time),
      items: [{channel: 'y', name: '完成轮次（估算）', valueFormatter: (value: number) => `${value.toFixed(1)} TPS`}]},
    animate: false});
  return {
    type: 'view', width, height, margin: 0,
    paddingLeft: detail ? 31 : 5, paddingRight: detail ? (seconds ? 25 : 20) : 6,
    paddingTop: detail ? 17 : 17, paddingBottom: detail ? 24 : 17,
    scale: {
      x: {type: 'linear', domain: data.bounds, nice: false, tickMethod: () => xTicks},
      y: {type: 'linear', domain, nice: false, tickMethod: () => [domain[0], (domain[0] + domain[1]) / 2, domain[1]]},
    },
    axis: detail ? {
      x: {title: false, tick: false, line: false, grid: false, labelFontFamily: font, labelFontSize: 11,
        labelFill: tone.ink, labelOpacity: 1, labelFillOpacity: 1, labelFormatter: tickLabel, labelAutoHide: true, labelAutoRotate: false},
      y: {title: false, tick: false, line: false, grid: true, gridStroke: tone.grid, gridLineWidth: 0.7, gridLineDash: [0, 0],
        labelFontFamily: font, labelFontSize: 11, labelFill: tone.ink, labelOpacity: 1, labelFillOpacity: 1, labelAutoHide: true},
    } : {x: false, y: false},
    legend: false,
    interaction: {tooltip: {shared: false, position: 'top-left', offset: [7, 7], bounding: {x: 0, y: 0, width, height}}},
    children,
  };
}

/** The caller's shared range owner supplies one conversation/configuration's
 * filtered output, exclusions and weighted mean for both chart and record count.
 */
export function ProductionPulseChart({result, detail = false, height, unavailable = false, paused = false}: {
  result: ChartRangeResult;
  detail?: boolean; height: number; unavailable?: boolean; paused?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null), schedule = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);
  // Preserve the SVG and tooltip when polling replaces identical records.
  const contentKey = pointsKey(result.points);
  const data = useMemo(() => prepare(result, detail, height, unavailable),
    [contentKey, result.bounds[0], result.bounds[1], result.average, result.excludedCount, result.error, detail, height, unavailable]);
  const latest = useRef(data); latest.current = data;
  const domain = yDomain(data);
  const blocked = unavailable || !!data.error || !data.valid.length;
  const caption = rangeCaption(data.bounds);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let chart: Chart | undefined, rendered: Prepared | undefined;
    let disposed = false, pending = false, running = false, renderedWidth = 0, renderedHeight = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      if (disposed || running) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const next = latest.current;
          if (next.unavailable || next.error || !next.valid.length) {
            if (rendered) chart?.clear();
            rendered = undefined;
            delete element.dataset.renderWidth; delete element.dataset.renderHeight;
            setFailed(false);
            continue;
          }
          const width = Math.round(element.clientWidth), nextHeight = Math.round(element.clientHeight);
          if (width < 12 || nextHeight < 12 || document.hidden) continue;
          if (rendered === next && renderedWidth === width && renderedHeight === nextHeight) continue;
          if (!chart) chart = new Chart({container: element, autoFit: false, width, height: nextHeight, renderer: new Renderer()});
          chart.options(options(next, width, nextHeight));
          if (rendered === next) await chart.changeSize(width, nextHeight);
          else await chart.render();
          if (disposed) break;
          rendered = next; renderedWidth = width; renderedHeight = nextHeight;
          element.dataset.renderWidth = String(width); element.dataset.renderHeight = String(nextHeight);
          const svg = element.querySelector('svg');
          if (svg) {svg.style.width = '100%'; svg.style.height = '100%'; svg.style.display = 'block';}
          setFailed(false);
        }
      } catch {if (!disposed) setFailed(true);}
      finally {running = false; if (pending && !disposed) void flush();}
    };
    const request = (settling = false) => {
      if (disposed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {pending = true; void flush();}, settling && rendered ? 80 : 0);
    };
    schedule.current = () => request();
    const observer = new ResizeObserver(() => request(true)); observer.observe(element);
    const visible = () => {if (!document.hidden) request();};
    document.addEventListener('visibilitychange', visible); request();
    return () => {
      disposed = true; schedule.current = null; clearTimeout(timer); observer.disconnect();
      document.removeEventListener('visibilitychange', visible); chart?.destroy();
    };
  }, []);
  useEffect(() => {schedule.current?.();}, [data]);

  const message = unavailable ? '暂时没有可用的统计' : data.error || (failed ? '曲线暂时不可用' : result.points.length ? '这段输出暂无可信计时' : detail ? '当前范围暂无输出' : '近30分钟暂无完成输出');
  return <div className={`production-pulse-chart${detail ? ' is-detail' : ''}`} style={{height}}
    role="img" aria-label={unavailable ? message : `${data.valid.length}次有效输出，${data.excluded}次缺测；${caption}；${domain[0]}至${domain[1]} TPS。灰色水平虚线为范围加权均值，金色细虚线仅连接缺测两端的真实读数，不补计缺测。`}
    data-valid-count={data.valid.length} data-gap-count={data.excluded} data-segment-count={data.segments.length} data-bridge-count={data.bridges.length}
    data-domain-start={data.bounds[0]} data-domain-end={data.bounds[1]} data-y-max={domain[1]} data-paused={paused}>
    <div ref={host} className="production-pulse-host" style={{visibility: blocked || failed ? 'hidden' : 'visible'}} />
    <span className="production-pulse-unit" aria-hidden="true">{detail || blocked ? 'TPS' : `0–${domain[1]} TPS`}</span>
    {!data.error && !unavailable && <span className="production-pulse-range" title={`${absoluteTime(data.bounds[0])} — ${absoluteTime(data.bounds[1])}`}>{caption}</span>}
    {(blocked || failed) && <span className="production-pulse-empty">{message}</span>}
  </div>;
}

export function ProductionQualityTrack({points, bounds}: {points: readonly PointView[]; bounds: readonly [number, number]}) {
  const host = useRef<HTMLDivElement>(null), [failed, setFailed] = useState(false);
  const key = pointsKey(points);
  const prepared = useMemo(() => points.map(p => ({time: Date.parse(p.time),
    valid: p.exclusion === null && typeof p.tps === 'number' && Number.isFinite(p.tps) && p.tps >= 0}))
    .filter(p => Number.isFinite(p.time) && p.time >= bounds[0] && p.time <= bounds[1]), [key, bounds[0], bounds[1]]);
  const validBounds = Number.isFinite(bounds[0]) && Number.isFinite(bounds[1]) && bounds[1] > bounds[0];
  const valid = prepared.filter(p => p.valid).length, excluded = prepared.length - valid;
  useEffect(() => {
    const element = host.current;
    if (!element || !validBounds) return;
    const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true');
    let space: CanvasSpace | undefined, disposed = false, frame = 0, drawingFailed = false;
    const draw = () => {
      if (disposed || drawingFailed || !space?.ready || document.hidden) return;
      try {
        const width = element.clientWidth;
        if (width < 1) return;
        space.clear('transparent'); const form = space.getForm();
        form.strokeOnly('#55594f', 1).line([new Pt(5, 13), new Pt(Math.max(5, width - 5), 13)]);
        for (const point of prepared) {
          const x = 5 + (point.time - bounds[0]) / (bounds[1] - bounds[0]) * Math.max(0, width - 10);
          if (point.valid) form.fillOnly('#a6b2a5').point(new Pt(x, 13), 2.6, 'circle');
          else form.strokeOnly('#dfb871', 1.8).line([new Pt(x - 3, 10), new Pt(x + 3, 16)])
            .line([new Pt(x - 3, 16), new Pt(x + 3, 10)]);
        }
      } catch {drawingFailed = true; space?.dispose(); canvas.remove(); if (!disposed) setFailed(true);}
    };
    const resize = () => {
      if (disposed || drawingFailed || document.hidden || element.clientWidth < 1) return;
      try {
        if (!space) {
          if (!canvas.getContext('2d')) throw new Error('Canvas unavailable');
          element.appendChild(canvas);
          space = new CanvasSpace(canvas).setup({bgcolor: 'transparent', resize: false, retina: true, pixelDensity: Math.min(window.devicePixelRatio || 1, 2)});
          space.add({start: resize, resize: draw}); setFailed(false);
        }
        // Use local client geometry, which is unaffected by a parent Flip
        // transform. Pts owns drawing; this observer alone owns its sizing.
        if (space.ready) space.resize(new Bound(new Pt(0, 0), new Pt(element.clientWidth, 26)));
      } catch {drawingFailed = true; space?.dispose(); canvas.remove(); if (!disposed) setFailed(true);}
    };
    const request = () => {cancelAnimationFrame(frame); frame = requestAnimationFrame(resize);};
    const observer = new ResizeObserver(request); observer.observe(element);
    document.addEventListener('visibilitychange', request); request();
    return () => {disposed = true; cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', request); space?.dispose(); canvas.remove();};
  }, [prepared, bounds[0], bounds[1], validBounds]);
  return <div ref={host} className="production-quality-track" role="img"
    aria-label={validBounds ? `记录质量：${valid}次有效，${excluded}次缺测；叉号只标记缺测时刻，不表示持续时长。` : '记录质量：时间范围不可用'}
    data-valid-count={valid} data-gap-count={excluded}>
    {(failed || !validBounds) && <span className="production-quality-fallback">{validBounds ? `${valid}次有效 · ${excluded}次缺测` : '时间范围不可用'}</span>}
  </div>;
}
