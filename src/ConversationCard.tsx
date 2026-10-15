import {useMemo, type DragEvent, type KeyboardEvent} from 'react';
import {Button, Dropdown, Tooltip} from 'antd';
import {CloseOutlined, CopyOutlined, InfoCircleOutlined, LineChartOutlined} from '@ant-design/icons';
import type {ProfileView, SampleView} from './contracts';
import {deriveChartRange} from './chart-range';
import {compactSpeed, conversationStateLabels, isValidSample, periodLabels, profileLabel, type ConversationRow, type Period} from './statistics';
import {ProductionPulseChart, ProductionQualityTrack} from './ProductionPulseChart';
import './conversation-card.css';

export type DropTarget = {id: string; placement: 'before' | 'after'};
export interface ReorderControls {
  enabled: boolean;
  draggingId: string | null;
  target: DropTarget | null;
  onStart: (event: DragEvent<HTMLElement>, id: string) => void;
  onEnd: () => void;
  onOver: (event: DragEvent<HTMLElement>, id: string) => void;
  onDrop: (event: DragEvent<HTMLElement>, id: string) => void;
  onKey: (event: KeyboardEvent<HTMLElement>, id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}
type Props = {
  row: ConversationRow; index: number; period: Period; now: number;
  available: boolean; selected: boolean; quiet?: boolean; paused?: boolean;
  samples: readonly SampleView[]; scopeBounds: [number, number]; chartProfile?: ProfileView;
  onSelect: () => void; onDetails: () => void; onCopy: () => void;
  reorder: ReorderControls; first: boolean; last: boolean;
};
const speed = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(1) : '—';
const rowState = (row: ConversationRow) => row.state === 'idle' ? '未运行' : row.state === 'unknown' ? '状态待确认' : conversationStateLabels[row.state];

export default function ConversationCard({row, index, period, now, available, selected, quiet = false, paused = false, samples, scopeBounds, chartProfile, onSelect, onDetails, onCopy, reorder, first, last}: Props) {
  const profile = row.latest ? row.outputProfile : row.currentProfile;
  const tier = compactSpeed(profile);
  const changed = Boolean(row.currentProfile && row.latest && row.currentProfile.id !== row.latest.profileId);
  const otherHistoryProfile = Boolean(selected && chartProfile && row.outputProfile && chartProfile.id !== row.outputProfile.id);
  const measured = Boolean(available && row.latest && isValidSample(row.latest));
  const latest = !available ? '—' : !row.latest ? '待测' : speed(measured ? row.latest.tps : null);
  const average = speed(available ? row.average : null);
  const history = useMemo(() => deriveChartRange(samples, {mode: 'auto'}, scopeBounds, now), [samples, scopeBounds, now]);
  const placement = reorder.target?.id === row.id ? reorder.target.placement : null;
  const titleMenu = {items: [{key: 'copy', label: '复制完整名称', icon: <CopyOutlined/>}], onClick: onCopy};

  return <div className={`conversation-item${quiet ? ' quiet-conversation-item' : ' conversation-card-slot'}${reorder.draggingId === row.id ? ' is-dragging' : ''}${placement ? ` drop-${placement}` : ''}`}
    data-conversation-id={row.id} data-drop-placement={placement || undefined}
    onDragOver={event => reorder.onOver(event, row.id)} onDrop={event => reorder.onDrop(event, row.id)}>
    <article className={`pulse-card is-compact${selected ? ' is-selected' : ''}${quiet ? ' is-quiet' : ''}`} data-card-id={row.id} aria-label={row.label}>
      <div className="card-identity">
        <div className="card-state-line">
          <div className="card-state-meta">
            <Dropdown trigger={['click']} menu={{items: [{key: 'up', label: '向前移动', disabled: first || !reorder.enabled}, {key: 'down', label: '向后移动', disabled: last || !reorder.enabled}], onClick: ({key}) => reorder.onMove(row.id, key === 'up' ? -1 : 1)}}>
              <Tooltip title="拖动编号调序；点击可前后移动；Alt + ↑ / ↓" placement="topLeft">
                <Button type="text" className="conversation-drag-handle card-order" draggable={reorder.enabled} aria-disabled={!reorder.enabled} aria-label={`调整 ${row.label} 的顺序`} aria-describedby="conversation-order-hint" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onDragStart={event => reorder.onStart(event, row.id)} onDragEnd={reorder.onEnd} onKeyDown={event => reorder.onKey(event, row.id)}>{String(index + 1).padStart(2, '0')}</Button>
              </Tooltip>
            </Dropdown>
            <span className={`card-state state-${row.state}`}><i aria-hidden="true"/>{rowState(row)}</span>
          </div>
          <Tooltip title={selected ? '收起曲线，保留当前位置' : '查看完成记录与测量依据'}>
            <Button type="text" className="card-focus-button" icon={selected ? <CloseOutlined/> : <LineChartOutlined/>} aria-label={`${selected ? '收起' : '查看'} ${row.label} 的历史曲线`} aria-expanded={selected} onClick={onSelect}/>
          </Tooltip>
        </div>
        <h3 className="card-title"><Dropdown trigger={['contextMenu']} menu={titleMenu}><Tooltip title={row.label} placement="topLeft" mouseEnterDelay={.35}>
          <Button type="text" className="conversation-row card-title-button" aria-label={`查看 ${row.label} 的输出详情`} aria-current={selected ? 'true' : undefined} aria-expanded={selected} onClick={onSelect}><span>{row.label}</span></Button>
        </Tooltip></Dropdown></h3>
        <div className="card-config">
          <Tooltip title={`${row.latest ? '最近完成输出的配置' : '当前观察，尚无完成记录'}：${profile?.model || '模型未知'}`}><span className="card-model">{profile?.model || '模型未知'}</span></Tooltip>
          <Tooltip title={changed ? `配置已变；当前 ${row.currentProfile ? profileLabel(row.currentProfile) : '未知'}。本卡读数仍属于最近完成输出的配置。` : `推理强度：${profile?.effort || '未知'}`}><span className={`card-effort${changed ? ' has-change' : ''}`}>{profile?.effort || '未知'}{changed && <InfoCircleOutlined aria-label="配置已变"/>}</span></Tooltip>
          <Tooltip title={tier.title}><span className="card-tier" data-tier-evidence={tier.source} tabIndex={0} aria-label={tier.title}>{tier.label}</span></Tooltip>
        </div>
      </div>
      <div className="card-reading">
        <div className="card-latest"><Tooltip title={row.latest ? `${measured ? '最近完成轮次' : '缺少可信计时'} · ${new Date(row.latest.completedAt).toLocaleString('zh-CN')}。TPS为完成后的估算。` : !available ? '统计暂不可用，等待恢复' : '尚无完成输出，不记为零'}><span className="card-reading-label">最近完成 <small>TPS</small></span></Tooltip>
          <strong title={latest} className={!row.latest ? 'is-unmeasured' : latest.length > 6 ? `reading-fit-${Math.min(10, latest.length)}` : undefined}>{latest}</strong>
        </div>
        <div className="card-mean"><Tooltip title={`最近输出同配置 · ${periodLabels[period]}加权均值，${row.validCount} 次有效${row.excludedCount ? `，${row.excludedCount} 次缺测不计入均值` : ''}`}><span className="card-reading-label">同配置均值</span></Tooltip><strong title={`${average} TPS`} className={average.length > 6 ? `reading-fit-${Math.min(10, average.length)}` : undefined}>{average}</strong></div>
      </div>
      {(!quiet || selected) && <div className="card-history">
        <div className="card-history-heading"><Tooltip title={`曲线仅显示 ${chartProfile ? profileLabel(chartProfile) : '所选输出配置'} 的${periodLabels[period]}记录，按输出时段自动聚焦。`}><span className={otherHistoryProfile ? 'history-other-profile' : undefined}>{otherHistoryProfile ? '所选配置历史' : selected ? '完成记录' : '完成轨迹'}</span></Tooltip>
          {selected ? <Button type="text" size="small" className="card-evidence-button" onClick={onDetails} aria-label={`查看 ${row.label} 的完整记录与配置`}>记录与配置</Button> : <Tooltip title={`${history.validCount} 次有效，${history.excludedCount} 次缺测；缺测断线，不按零计算。`}><span className="card-record-count">{history.validCount} 次{history.excludedCount > 0 && <b> · 缺测 {history.excludedCount}</b>}</span></Tooltip>}
        </div>
        <ProductionPulseChart samples={samples} scopeBounds={scopeBounds} now={now} detail={selected} height={selected ? 90 : 66} unavailable={!available} paused={paused}/>
        {selected && <div className="card-quality"><ProductionQualityTrack points={available ? history.points : []} bounds={history.bounds}/></div>}
      </div>}
    </article>
  </div>;
}
