import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Select } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import type { SampleView } from './contracts';
import { deriveChartRange, type ChartRangeMode, type ChartRangeSelection } from './chart-range';
import { TodayChart } from './TodayChart';
import './chart-history.css';

interface SpeedHistoryProps {
  samples: SampleView[];
  scopeBounds: [number, number];
  now: number;
  paused: boolean;
  unavailable: boolean;
  expandedView: boolean;
  onClose: () => void;
  profileLabel?: string;
}

const modes: { value: ChartRangeMode; label: string }[] = [
  { value: 'auto', label: '自动范围' },
  { value: 'hour', label: '近 1 小时' },
  { value: 'today', label: '今天' },
  { value: 'day', label: '指定日期' },
  { value: 'custom', label: '自定义时间' },
];
const pad = (value: number) => String(value).padStart(2, '0');
const localDay = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const localMinute = (time: number) => {
  const date = new Date(time);
  return `${localDay(time)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const rangeCaption = (bounds: [number, number]) => {
  const [start, end] = bounds.map((value) => new Date(value));
  const datePart = (date: Date) => `${date.getMonth() + 1}/${date.getDate()}`;
  const timePart = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = localDay(bounds[0]) === localDay(bounds[1]);
  return `${datePart(start)} ${timePart(start)} — ${sameDay ? '' : `${datePart(end)} `}${timePart(end)}`;
};

export function SpeedHistory({ samples, scopeBounds, now, paused, unavailable, expandedView, onClose, profileLabel }: SpeedHistoryProps) {
  const [selection, setSelection] = useState<ChartRangeSelection>({ mode: 'auto' });
  const [editorMode, setEditorMode] = useState<ChartRangeMode>('auto');
  const [day, setDay] = useState(() => localDay(now));
  const [start, setStart] = useState(() => localMinute(now - 3_600_000));
  const [end, setEnd] = useState(() => localMinute(now));
  const [error, setError] = useState('');
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const resize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const result = useMemo(() => deriveChartRange(samples, selection, scopeBounds, now), [samples, selection, scopeBounds, now]);
  const draft = editorMode === 'day' ? { mode: editorMode, day } : { mode: editorMode, start, end };
  const pending = (editorMode === 'day' || editorMode === 'custom') && JSON.stringify(draft) !== JSON.stringify(selection);
  const span = result.bounds[1] - result.bounds[0];
  // A longer or denser range gets more reading space, bounded by this desktop.
  const preferredHeight = span >= 86_400_000 || result.points.length > 36 ? 280 : 240;
  const reservedHeight = editorMode === 'custom' ? 300 : editorMode === 'day' ? 268 : 230;
  const expandedHeight = Math.min(preferredHeight, Math.max(160, viewportHeight - reservedHeight));

  function changeMode(mode: ChartRangeMode) {
    setEditorMode(mode);
    setError('');
    if (mode !== 'day' && mode !== 'custom') setSelection({ mode });
  }
  function applyRange() {
    const next: ChartRangeSelection = editorMode === 'day' ? { mode: 'day', day } : { mode: 'custom', start, end };
    const checked = deriveChartRange(samples, next, scopeBounds, now);
    if (checked.error) { setError(checked.error); return; }
    setSelection(next);
    setError('');
  }

  const renderHistory = (large: boolean) => <section className={`speed-history${large ? ' is-enlarged' : ''}`} data-time-mode={selection.mode} data-editor-mode={editorMode} data-valid-count={unavailable ? 0 : result.validCount} data-gap-count={unavailable ? 0 : result.excludedCount} data-domain-start={result.bounds[0]} data-domain-end={result.bounds[1]} aria-label="输出速度历史">
    <div className="chart-range-toolbar">
      <Select className="chart-range-select no-drag" aria-label="曲线时间范围" value={editorMode} options={modes} onChange={changeMode} popupMatchSelectWidth={false} getPopupContainer={() => document.body} />
      <span className="chart-range-caption" title={result.label}>{rangeCaption(result.bounds)}</span>
    </div>
    {(editorMode === 'day' || editorMode === 'custom') && <div className={`chart-range-editor mode-${editorMode}`}>
      {editorMode === 'day' ? <label><span>日期</span><Input type="date" aria-label="曲线日期" value={day} onChange={(event) => { setDay(event.target.value); setError(''); }} /></label> : <>
        <label><span>开始</span><Input type="datetime-local" aria-label="开始时间" value={start} onChange={(event) => { setStart(event.target.value); setError(''); }} /></label>
        <label><span>结束</span><Input type="datetime-local" aria-label="结束时间" value={end} onChange={(event) => { setEnd(event.target.value); setError(''); }} /></label>
      </>}
      <Button className="chart-apply" icon={<CheckOutlined />} aria-label="应用时间范围" onClick={applyRange}>应用</Button>
    </div>}
    {(error || result.error || pending) && <p className={`chart-range-feedback${error || result.error ? ' has-error' : ''}`} role={error || result.error ? 'alert' : 'status'}>{error || result.error || '点击“应用”查看所选时间，当前曲线保持不变。'}</p>}
    <div className="chart-reading">
      <span>{unavailable ? '暂无可用统计' : <><strong>{result.validCount}</strong> 次有效{result.excludedCount > 0 && <span className="chart-excluded"> · {result.excludedCount} 次缺测</span>}</>}</span>
      <span>范围均值 <strong data-chart-average>{unavailable || result.average === null ? '—' : result.average.toFixed(1)}</strong><small> TPS</small></span>
    </div>
    <TodayChart points={unavailable ? [] : result.points} average={unavailable ? null : result.average} range={result.bounds} paused={paused || (!large && expandedView)} unavailable={unavailable} height={large ? expandedHeight : 190} enlarged={large} />
    <p className="chart-history-footnote">{selection.mode === 'auto' ? '自动聚焦所选统计范围内的输出时段。' : '按本机时间显示所选时段。'}灰色水平虚线为加权均值；金色细虚线连接缺测两端的真实读数，不补数据。</p>
  </section>;

  return <>
    <div className="history-heading"><h2>输出速度</h2><span>完成输出后的估算</span></div>
    {renderHistory(false)}
    <Modal title="输出速度" className="chart-history-modal" open={expandedView} onCancel={onClose} footer={null} width={560} centered destroyOnHidden maskClosable styles={{ body: { maxHeight: 'calc(100vh - 126px)', overflowY: 'auto', overflowX: 'hidden' } }}>
      {profileLabel && <p className="chart-profile-caption">{profileLabel}</p>}
      {renderHistory(true)}
    </Modal>
  </>;
}
