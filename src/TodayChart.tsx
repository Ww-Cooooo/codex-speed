import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Chart } from '@antv/g2';
import { Renderer } from '@antv/g-svg';
import { CanvasSpace, Pt } from 'pts';
import type { PointView } from './contracts';

type PlotPoint = { time: number; tps: number };
const PADDING = { top: 16, right: 12, bottom: 34, left: 40 };
const timeLabel = (value: unknown, includeDate = false, includeSeconds = false) => {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', ...(includeSeconds ? { second: '2-digit' } : {}), hour12: false });
  return includeDate ? `${date.getMonth() + 1}/${date.getDate()} ${time}` : time;
};

function prepare(points: PointView[], range?: [number, number]) {
  const sorted = points.filter((point) => Number.isFinite(Date.parse(point.time))).map((point) => ({
    time: Date.parse(point.time),
    tps: typeof point.tps === 'number' && Number.isFinite(point.tps) && point.tps >= 0 && !point.exclusion ? point.tps : null,
  })).sort((a, b) => a.time - b.time);
  const segments: PlotPoint[][] = [];
  let segment: PlotPoint[] = [];
  for (const point of sorted) {
    if (point.tps === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push({ time: point.time, tps: point.tps });
  }
  if (segment.length) segments.push(segment);
  const valid = segments.flat();
  const gaps = sorted.filter((point) => point.tps === null).map((point) => point.time);
  const first = sorted[0]?.time ?? Date.now();
  const last = sorted.at(-1)?.time ?? first;
  // A single real sample still gets readable time coordinates, without inventing samples.
  const domain: [number, number] = range && range[1] > range[0] ? range : first === last ? [first - 30 * 60_000, first + 30 * 60_000] : [first, last];
  return { segments, valid, gaps, domain };
}

function GapBand({ gaps, domain, paused }: { gaps: number[]; domain: [number, number]; paused: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (!host.current || !gaps.length || paused) return;
    const element = host.current;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    element.appendChild(canvas);
    let space: CanvasSpace | undefined;
    try {
      space = new CanvasSpace(canvas).setup({ bgcolor: 'transparent', resize: true, retina: true, pixelDensity: Math.min(window.devicePixelRatio || 1, 2) });
      const form = space.getForm();
      const draw = () => {
        if (!space?.ready || !form.ctx || document.hidden) return;
        space.clear('transparent');
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (width < 1 || height < 1) return;
        form.strokeOnly('#bfa77c', 1);
        for (const gap of gaps) {
          const x = (gap - domain[0]) / (domain[1] - domain[0]) * width;
          // The narrow band marks an excluded sample's time, not an invented outage duration.
          for (let offset = -7; offset <= 7; offset += 4) {
            form.line([new Pt(Math.max(0, x + offset - 3), height), new Pt(Math.min(width, x + offset + 3), 0)]);
          }
        }
      };
      space.add({ start: draw, resize: draw });
      const observer = new ResizeObserver(draw);
      observer.observe(element);
      document.addEventListener('visibilitychange', draw);
      setFallback(false);
      return () => {
        observer.disconnect();
        document.removeEventListener('visibilitychange', draw);
        space?.dispose();
        canvas.remove();
      };
    } catch {
      space?.dispose();
      canvas.remove();
      setFallback(true);
    }
  }, [gaps, domain, paused]);
  return <div ref={host} className="gap-band" aria-hidden="true">
    {fallback && gaps.map((gap, index) => <i key={index} style={{ left: `${(gap - domain[0]) / (domain[1] - domain[0]) * 100}%` }} />)}
  </div>;
}

export function TodayChart({ points, average, range, paused, unavailable = false, height = 190, enlarged = false }: { points: PointView[]; average: number | null; range?: [number, number]; paused: boolean; unavailable?: boolean; height?: number; enlarged?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(500);
  // Polling replaces arrays even when the samples have not changed. Stable
  // content dependencies preserve the SVG and a user's open tooltip.
  const pointsKey = points.map((point) => `${point.time}|${point.tps ?? ''}|${point.exclusion ?? ''}`).join(';');
  const rangeKey = range?.join(',') ?? '';
  const data = useMemo(() => prepare(points, range), [pointsKey, rangeKey]);
  const span = data.domain[1] - data.domain[0];
  const crossesDay = new Date(data.domain[0]).toDateString() !== new Date(data.domain[1]).toDateString();
  const plotPadding = crossesDay ? { ...PADDING, left: 64, right: 64 } : PADDING;
  const labelWidth = crossesDay ? 102 : span <= 5 * 60_000 ? 76 : 63;
  const tickCount = Math.max(2, Math.min(enlarged ? 6 : 5, Math.floor((width - plotPadding.left - plotPadding.right) / labelWidth)));
  const pointRadius = data.valid.length > 200 ? 1.2 : data.valid.length > 60 ? 1.8 : data.valid.length > 12 ? 2.5 : 3.5;
  useEffect(() => {
    if (!host.current) return;
    const element = host.current;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    setWidth(element.clientWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!host.current || paused || !data.valid.length) return;
    const element = host.current;
    let disposed = false;
    let instance: Chart | null = null;
    try {
      if (element.clientWidth < 1 || element.clientHeight < 1) return;
      instance = new Chart({ container: element, autoFit: true, renderer: new Renderer(),
        paddingTop: plotPadding.top, paddingRight: plotPadding.right, paddingBottom: plotPadding.bottom, paddingLeft: plotPadding.left });
      chart.current = instance;
      const values = data.valid.map((point) => point.tps);
      if (average !== null && Number.isFinite(average)) values.push(average);
      const min = Math.max(0, Math.floor((Math.min(...values) - 10) / 10) * 10);
      const max = Math.max(min + 20, Math.ceil((Math.max(...values) + 10) / 10) * 10);
      instance.scale('x', { type: 'time', domain: data.domain, tickCount, nice: false });
      instance.scale('y', { domain: [min, max], tickCount: height >= 240 ? 5 : 4, nice: false });
      instance.axis('x', { title: false, tick: false, line: false, grid: false, labelFontFamily: 'Space Grotesk, Noto Sans SC, sans-serif', labelFontSize: enlarged ? 12 : 11, labelFill: '#b9a48c', labelOpacity: 1, labelFillOpacity: 1, labelFormatter: (value: unknown) => timeLabel(value, crossesDay, span <= 5 * 60_000), labelAutoHide: true });
      instance.axis('y', { title: false, tick: false, line: false, grid: true, gridStroke: '#454137', gridStrokeOpacity: 1, gridLineDash: [0, 0], labelFontFamily: 'Space Grotesk, Noto Sans SC, sans-serif', labelFontSize: enlarged ? 12 : 11, labelFill: '#b9a48c', labelOpacity: 1, labelFillOpacity: 1 });
      instance.legend(false);
      instance.interaction('tooltip', { shared: false, position: 'top-left', offset: [8, 8],
        bounding: { x: 0, y: 0, width: element.clientWidth, height: element.clientHeight } });
      if (average !== null && Number.isFinite(average)) instance.line()
        .data(data.domain.map((time) => ({ time, tps: average }))).encode('x', 'time').encode('y', 'tps')
        .style('stroke', '#958c78').style('lineWidth', 1).style('lineDash', [3, 4]).tooltip(false).animate(false);
      for (const segment of data.segments) if (segment.length > 1) instance.line()
        .data(segment).encode('x', 'time').encode('y', 'tps').style('stroke', '#edbd5b').style('lineWidth', 2).tooltip(false).animate(false);
      instance.point().data(data.valid).encode('x', 'time').encode('y', 'tps').encode('size', pointRadius)
        .style('fill', '#edbd5b').style('stroke', '#24241f').style('lineWidth', data.valid.length > 60 ? 0.7 : 1.3)
        .tooltip({ title: (datum: PlotPoint) => timeLabel(datum.time, true, true), items: [{ channel: 'y', name: '生成速度（估算）', valueFormatter: (value: number) => `${value.toFixed(1)} TPS` }] }).animate(false);
      const render = instance.render();
      Promise.resolve(render).then(() => { if (!disposed) setFailed(false); }).catch(() => { if (!disposed) setFailed(true); });
    } catch { setFailed(true); }
    return () => {
      disposed = true;
      instance?.destroy();
      if (chart.current === instance) chart.current = null;
    };
  }, [data, average, paused, height, enlarged, width, tickCount, pointRadius, crossesDay, span]);

  const summary = data.valid.length ? `${data.valid.length} 次有效输出，${data.gaps.length} 次无法测量；虚线为按生成秒数加权的平均值。` : '当前范围还没有可测量的输出。';
  return <div className="plot-wrap" style={{ '--chart-height': `${height}px`, height } as CSSProperties} role="img" aria-label={summary} data-domain-start={data.domain[0]} data-domain-end={data.domain[1]} data-valid-count={data.valid.length} data-gap-count={data.gaps.length} data-segment-count={data.segments.length} data-point-radius={pointRadius} data-tick-count={tickCount} data-chart-height={height}>
    <div ref={host} className="plot-host" />
    <div className="gap-track" style={{ left: plotPadding.left, right: plotPadding.right }}><GapBand gaps={data.gaps} domain={data.domain} paused={paused} /></div>
    {(!data.valid.length || failed) && <div className="plot-empty">
      <span>{failed ? '曲线暂时不可用' : unavailable ? '暂时没有可用的统计' : points.length ? '当前范围的输出暂时无法测量' : '当前范围暂无输出'}</span>
      <small>{failed ? '上方读数仍可查看' : unavailable ? '统计恢复后，曲线会显示在这里' : '可信计时齐全后，曲线会显示在这里'}</small>
    </div>}
  </div>;
}
