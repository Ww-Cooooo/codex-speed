import {useEffect, useMemo, useRef, useState} from 'react';
import {Chart, type G2Spec, type Mark} from '@antv/g2';
import {Renderer} from '@antv/g-svg';
import {prepareTrendTraces, type TrendDomain, type TrendTrace} from './linked-trend';
import type {PlotPoint} from './chart-series';
import './linked-trend.css';

export {deriveTrendDomain, type TrendDomain, type TrendTrace} from './linked-trend';

const font = 'Space Grotesk, Noto Sans SC, sans-serif';
const absoluteTime = (time: number) => new Date(time).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
type PreparedTrace = ReturnType<typeof prepareTrendTraces>[number];

function specification(traces: readonly PreparedTrace[], domain: TrendDomain, width: number, height: number, focus: boolean, muted: boolean): G2Spec {
  const children: Mark[] = [], opacity = muted ? 0.26 : 1;
  for (const trace of traces) {
    for (const [index, segment] of trace.series.segments.entries()) if (segment.length > 1) children.push({
      type: 'line', key: `${trace.id}-run-${index}`, data: segment,
      encode: {x: 'time', y: 'tps'},
      style: {stroke: trace.color, lineWidth: focus ? 2.8 : 2, opacity},
      animate: false, tooltip: false,
    });
    for (const [index, bridge] of trace.series.bridges.entries()) children.push({
      type: 'line', key: `${trace.id}-missing-bridge-${index}`, data: bridge,
      encode: {x: 'time', y: 'tps'},
      style: {stroke: '#dfb871', lineWidth: 1, lineDash: [2, 3], strokeOpacity: 0.8, opacity},
      animate: false, tooltip: false,
    });
    children.push({
      type: 'point', key: `${trace.id}-readings`, data: trace.series.valid,
      encode: {x: 'time', y: 'tps', size: trace.series.valid.length > 100 ? 2 : focus ? 3.8 : 3},
      style: {fill: trace.color, stroke: '#171b1c', lineWidth: 1.2, opacity}, animate: false,
      tooltip: focus ? {
        title: (point: PlotPoint) => `${trace.name} · ${absoluteTime(point.time)}`,
        items: [{channel: 'y', name: '完成轮次（估算）', valueFormatter: (value: number) => `${value.toFixed(1)} TPS`}],
      } : false,
    });
  }
  const span = domain.x[1] - domain.x[0], dateTicks = span >= 86_400_000;
  const tickCount = width < 360 ? 3 : 4;
  const ticks = Array.from({length: tickCount}, (_, index) => domain.x[0] + span * index / (tickCount - 1));
  const clock = (value: unknown) => new Date(Number(value)).toLocaleString('zh-CN', dateTicks
    ? {month: 'numeric', day: 'numeric'}
    : {hour: '2-digit', minute: '2-digit', ...(span <= 300_000 && width >= 360 ? {second: '2-digit' as const} : {}), hour12: false});
  return {
    type: 'view', width, height, margin: 0,
    // Focus and overview use identical plot insets as well as identical axes.
    paddingLeft: 35, paddingRight: 25, paddingTop: 12, paddingBottom: 25,
    scale: {
      x: {type: 'linear', domain: domain.x, nice: false, tickMethod: () => ticks},
      y: {type: 'linear', domain: domain.y, nice: false, tickCount: 4},
    },
    axis: focus ? {x: false, y: false} : {
      x: {title: false, tick: false, line: false, grid: false, labelFormatter: clock,
        labelFontFamily: font, labelFontSize: 11, labelFill: '#a8b0b1', labelOpacity: 1, labelAutoHide: true, labelAutoRotate: false},
      y: {title: false, tick: false, line: false, grid: true, gridStroke: '#394143', gridLineDash: [2, 5], gridLineWidth: 0.6,
        labelFontFamily: font, labelFontSize: 11, labelFill: '#a8b0b1', labelOpacity: 1, labelAutoHide: true},
    },
    legend: false,
    interaction: {tooltip: {shared: false, position: 'top-left', offset: [8, 8], bounding: {x: 0, y: 0, width, height}}},
    children,
  };
}

export function LinkedTrendPlot({traces, domain, focus = false, muted = false}: {
  traces: readonly TrendTrace[]; domain: TrendDomain; focus?: boolean; muted?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null);
  const schedule = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);
  const contentKey = JSON.stringify(traces.map(trace => [trace.id, trace.name, trace.color,
    trace.points.map(point => [point.time, point.tps, point.exclusion])]));
  const prepared = useMemo(() => prepareTrendTraces(traces), [contentKey]);
  const current = useMemo(() => ({traces: prepared, domain: {x: [...domain.x], y: [...domain.y]} as TrendDomain, focus, muted}),
    [prepared, domain.x[0], domain.x[1], domain.y[0], domain.y[1], focus, muted]);
  const latest = useRef(current); latest.current = current;
  const valid = prepared.reduce((total, trace) => total + trace.series.valid.length, 0);
  const gaps = prepared.reduce((total, trace) => total + trace.series.gaps.length, 0);
  const bridges = prepared.reduce((total, trace) => total + trace.series.bridges.length, 0);

  useEffect(() => {
    const element = host.current, frame = surface.current;
    if (!element || !frame) return;
    let chart: Chart | undefined, rendered: typeof current | undefined;
    let disposed = false, busy = false, pending = false, renderedWidth = 0, renderedHeight = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      if (disposed || busy) return;
      busy = true;
      try {
        while (pending && !disposed) {
          pending = false;
          // Measure the layout owner, not G2's container. G2 writes positioning
          // styles to its container, whose SVG can otherwise hold the old size.
          const next = latest.current, width = Math.round(frame.clientWidth), height = Math.round(frame.clientHeight);
          if (document.hidden || width < 20 || height < 20) continue;
          if (rendered === next && renderedWidth === width && renderedHeight === height) continue;
          if (!chart) chart = new Chart({container: element, renderer: new Renderer(), autoFit: false, width, height});
          chart.options(specification(next.traces, next.domain, width, height, next.focus, next.muted));
          // changeSize itself renders the new specification. Apply it when
          // content and size change together too, without a second render.
          if (renderedWidth !== width || renderedHeight !== height) await chart.changeSize(width, height);
          else await chart.render();
          if (disposed) break;
          rendered = next; renderedWidth = width; renderedHeight = height;
          element.dataset.renderWidth = String(width); element.dataset.renderHeight = String(height);
          const svg = element.querySelector('svg');
          if (svg) {svg.style.width = '100%'; svg.style.height = '100%'; svg.style.display = 'block';}
          setFailed(false);
        }
      } catch {if (!disposed) setFailed(true);}
      finally {busy = false; if (pending && !disposed) void flush();}
    };
    const request = (settling = false) => {
      if (disposed) return;
      clearTimeout(timer);
      // Flip changes only the parent surface transform. A genuine drag resize
      // settles before G2 lays out its labels instead of relayout on each frame.
      timer = setTimeout(() => {pending = true; void flush();}, settling && rendered ? 80 : 0);
    };
    schedule.current = () => request();
    const observer = new ResizeObserver(() => request(true)); observer.observe(frame);
    const visible = () => {if (!document.hidden) request();};
    document.addEventListener('visibilitychange', visible); request();
    return () => {
      disposed = true; schedule.current = null; clearTimeout(timer); observer.disconnect();
      document.removeEventListener('visibilitychange', visible); chart?.destroy();
    };
  }, []);
  useEffect(() => {schedule.current?.();}, [current]);

  const message = failed ? '图表暂时无法绘制；读数仍可查看。' : gaps ? '当前范围暂无可信计时' : '当前范围暂无完成输出';
  return <div ref={surface} className={`linked-trend-plot${focus ? ' is-focus' : ''}`} role="img"
    aria-label={`${focus ? '所选对话' : '共用时间轴'}；${absoluteTime(domain.x[0])} 至 ${absoluteTime(domain.x[1])}；${domain.y[0]} 至 ${domain.y[1]} TPS；${valid}次有效，${gaps}次缺测。金色细虚线仅连接缺测两端的真实读数，不补计缺测；单点不连线，尾部不外推。`}
    data-y-min={domain.y[0]} data-y-max={domain.y[1]} data-domain-start={domain.x[0]} data-domain-end={domain.x[1]}
    data-series={traces.length} data-valid-count={valid} data-gap-count={gaps} data-bridge-count={bridges}>
    <div className="linked-trend-host" ref={host} style={{visibility: failed ? 'hidden' : 'visible'}} />
    {(failed || !valid) && !muted && <span className="linked-trend-empty">{message}</span>}
  </div>;
}
