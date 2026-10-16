import {forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type CSSProperties, type RefObject} from 'react';
import {flushSync} from 'react-dom';
import {Button, Dropdown, Tooltip} from 'antd';
import {CopyOutlined, DownOutlined, InfoCircleOutlined, RightOutlined} from '@ant-design/icons';
import {gsap} from 'gsap';
import {Flip} from 'gsap/Flip';
import {useGSAP} from '@gsap/react';
import type {LenisRef} from 'lenis/react';
import type {PointView, ProfileView, SampleView} from './contracts';
import type {ReorderControls} from './ConversationCard';
import {deriveRecentChartRange, RECENT_CHART_WINDOW} from './chart-range';
import {compactSpeed, conversationStateLabels, isRunning, isValidSample, periodLabels, profileLabel, type ConversationRow, type Period} from './statistics';
import {ProductionQualityTrack} from './ProductionPulseChart';
import {LinkedTrendPlot} from './LinkedTrendPlot';
import {deriveTrendDomain, type TrendTrace} from './linked-trend';
import './linked-workspace.css';

gsap.registerPlugin(Flip, useGSAP);
export type LinkedGroup = 'running' | 'idle' | 'unknown';
export interface LinkedWorkspaceHandle { select: (id: string | null) => void }
export interface LinkedWorkspaceProps {
  rows: ConversationRow[];
  groups: Record<LinkedGroup, ConversationRow[]>;
  groupedView: boolean;
  openGroups: Record<LinkedGroup, boolean>;
  conversation: string | null;
  onSelect: (id: string | null) => void;
  onToggleGroup: (group: LinkedGroup) => void;
  period: Period;
  histories: Map<string, SampleView[]>;
  chartProfile?: ProfileView;
  now: number;
  available: boolean;
  pendingRunning: ReadonlySet<string>;
  reorder: ReorderControls;
  onDetails: () => void;
  onCopyName: (label: string) => void;
  onPendingDismiss: (id: string) => void;
  scrollRef: RefObject<LenisRef | null>;
  reduced: boolean;
  paused: boolean;
}

const colors = ['#9bb6d4', '#e3c784', '#92d4ce', '#b7a9e8', '#b4cc9b', '#d6a786', '#d3a4be', '#9bb8a8', '#b0cbd4', '#d2c09f', '#c6c88e', '#9eabdc'];
// IDs, rather than list positions, own color. Polling, grouping and manual order
// changes must not change the identity the eye is following.
const colorHash = (id: string) => {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  // Mix high and low bits; repeated hexadecimal suffixes should not all land on
  // one of the palette's few low-bit buckets.
  return ((hash >>> 16) ^ (hash >>> 0)) >>> 0;
};
const numeric = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(1) : '—';
const latestReading = (row: ConversationRow, available: boolean) => !available ? '—' : !row.latest ? '待测' : numeric(isValidSample(row.latest) ? row.latest.tps : null);
const stateLabel = (row: ConversationRow) => row.state === 'idle' ? '未运行' : row.state === 'unknown' ? '状态待确认' : conversationStateLabels[row.state];
const groupNames: Record<LinkedGroup, string> = {running: '正在运行', idle: '未运行', unknown: '状态待确认'};
const flipStyles = 'transform,transformOrigin,width,height,position,top,left,right,bottom,minWidth,minHeight,maxWidth,maxHeight,zIndex,fontSize,lineHeight,padding,opacity';
type SelectionMotion = {state: ReturnType<typeof Flip.getState>; travel: ReturnType<typeof Flip.getState>; chart: ReturnType<typeof Flip.getState>; previous: string | null; next: string | null; revision: number; emphasis: {heading: number; focus: number; quality: number}};

/** A single layout owns both the comparison and the focused working state. Each
 * keyed record stays mounted while its grid position changes; it is never copied
 * into a second detail header. Snapshot/state/persistence remain App-owned. */
const LinkedWorkspace = forwardRef<LinkedWorkspaceHandle, LinkedWorkspaceProps>(function LinkedWorkspace({
  rows, groups, groupedView, openGroups, conversation, onSelect, onToggleGroup,
  period, histories, chartProfile, now, available, pendingRunning, reorder,
  onDetails, onCopyName, onPendingDismiss, scrollRef, reduced, paused,
}, forwardedRef) {
  const root = useRef<HTMLElement>(null);
  const motion = useRef<gsap.core.Timeline | null>(null);
  const pending = useRef<SelectionMotion | null>(null);
  const revision = useRef(0);
  const overviewPosition = useRef<number | null>(null);
  const lastSelection = useRef(conversation);
  const assignedColors = useRef(new Map<string, string>());
  const knownColors = new Set(assignedColors.current.values());
  for (const row of [...rows].sort((a, b) => Number(runningIdsForColor(groups, b.id)) - Number(runningIdsForColor(groups, a.id)) || a.id.localeCompare(b.id))) {
    if (assignedColors.current.has(row.id)) continue;
    const first = colorHash(row.id) % colors.length;
    let color = colors[first];
    for (let i = 0; i < colors.length; i++) if (!knownColors.has(colors[(first + i) % colors.length])) {color = colors[(first + i) % colors.length]; break;}
    assignedColors.current.set(row.id, color); knownColors.add(color);
  }
  const traceColor = (id: string) => assignedColors.current.get(id) ?? colors[colorHash(id) % colors.length];
  const {contextSafe} = useGSAP({scope: root});
  const selectedRow = rows.find(row => row.id === conversation);
  const runningIds = useMemo(() => new Set(groups.running.map(row => row.id)), [groups.running]);
  const recent = useMemo(() => new Map(rows.map(row => {
    const profile = row.id === conversation && chartProfile ? chartProfile : row.outputProfile ?? row.currentProfile;
    const samples = profile ? histories.get(`${row.id}:${profile.id}`) ?? [] : [];
    return [row.id, deriveRecentChartRange(available ? samples : [], now)] as const;
  })), [rows, histories, conversation, chartProfile, now, available]);
  const traces = useMemo<TrendTrace[]>(() => rows.filter(row => runningIds.has(row.id) || row.id === conversation).map(row => ({
    id: row.id, name: row.label, color: traceColor(row.id), points: recent.get(row.id)?.points ?? [],
  })), [rows, runningIds, recent, conversation]);
  const focused = useMemo(() => traces.filter(trace => trace.id === conversation), [traces, conversation]);
  const domain = useMemo(() => deriveTrendDomain(traces, [now - RECENT_CHART_WINDOW, now]), [traces, now]);
  const focusHistory = conversation ? recent.get(conversation) : undefined;
  const focusPoints: PointView[] = focusHistory?.points ?? [];
  const hasFocusReadings = focusPoints.some(point => point.tps !== null && !point.exclusion);
  const actualRunning = groups.running.filter(row => isRunning(row.state) && !pendingRunning.has(row.id)).length;
  const waitingRecords = groups.running.filter(row => pendingRunning.has(row.id)).length;

  const settle = contextSafe(() => {
    const element = root.current;
    if (!element) return;
    revision.current += 1;
    pending.current = null;
    motion.current?.kill(); motion.current = null;
    const targets = element.querySelectorAll('[data-linked-flip]');
    Flip.killFlipsOf(targets, false);
    gsap.set(targets, {clearProps: flipStyles});
    element.querySelectorAll('[data-travelling]').forEach(target => target.removeAttribute('data-travelling'));
    element.dataset.moving = 'false';
    gsap.set(element.querySelector('.linked-overview-heading'), {clearProps: 'opacity'});
    gsap.set(element.querySelectorAll('.linked-focus-layer,.linked-quality-content'), {clearProps: 'opacity'});
  });

  const choose = contextSafe((id: string | null) => {
    const element = root.current;
    if (!element || id === conversation) return;
    const targets = element.querySelectorAll('[data-linked-flip]:not(.linked-chart)');
    const chart = element.querySelector('.linked-chart');
    if (!chart) { onSelect(id); return; }
    // Freeze the visible pose without completing the old trip. getState() would
    // otherwise settle an active Flip before recording it.
    Flip.killFlipsOf(element.querySelectorAll('[data-linked-flip]'), false);
    motion.current?.kill();
    const travels = (target: Element) => {
      const record = target.closest<HTMLElement>('.linked-record');
      return !!record && (record.dataset.conversationId === conversation || record.dataset.conversationId === id);
    };
    const state = Flip.getState([...targets].filter(target => !travels(target)), {props: 'fontSize,lineHeight,padding'});
    const travel = Flip.getState([...targets].filter(travels), {props: 'fontSize,lineHeight,padding'});
    const chartState = Flip.getState(chart);
    gsap.set(element.querySelectorAll('[data-linked-flip]'), {clearProps: flipStyles});
    if (!conversation && id) overviewPosition.current = scrollRef.current?.wrapper?.scrollTop ?? 0;
    const opacity = (selector: string) => Number(gsap.getProperty(element.querySelector(selector), 'opacity'));
    pending.current = {state, travel, chart: chartState, previous: conversation, next: id, revision: ++revision.current,
      emphasis: {heading: opacity('.linked-overview-heading'), focus: opacity('.linked-focus-layer'), quality: opacity('.linked-quality-content')}};
    flushSync(() => onSelect(id));
  });
  useImperativeHandle(forwardedRef, () => ({select: choose}), [choose]);

  useLayoutEffect(() => {
    const element = root.current, transition = pending.current;
    if (!element) return;
    const changed = lastSelection.current !== conversation;
    lastSelection.current = conversation;
    if (!changed) return;
    const position = conversation ? 0 : overviewPosition.current ?? 0;
    scrollRef.current?.lenis?.resize();
    if (scrollRef.current?.lenis) scrollRef.current.lenis.scrollTo(position, {immediate: true, force: true});
    else if (scrollRef.current?.wrapper) scrollRef.current.wrapper.scrollTop = position;
    if (!conversation) overviewPosition.current = null;
    if (!transition || transition.next !== conversation || reduced || paused) {settle(); return;}
    pending.current = null;
    element.dataset.moving = 'true';
    gsap.set(element.querySelector('.linked-overview-heading'), {opacity: transition.emphasis.heading});
    gsap.set(element.querySelector('.linked-focus-layer'), {opacity: transition.emphasis.focus});
    gsap.set(element.querySelector('.linked-quality-content'), {opacity: transition.emphasis.quality});
    element.querySelectorAll<HTMLElement>('.linked-record').forEach(record => {
      if (record.style.display !== 'none') record.dataset.travelling = record.dataset.conversationId === transition.previous || record.dataset.conversationId === transition.next ? 'subject' : 'neighbor';
      else record.removeAttribute('data-travelling');
    });
    const tl = gsap.timeline({onComplete: contextSafe(() => {
      if (revision.current !== transition.revision) return;
      element.dataset.moving = 'false';
      element.querySelectorAll('[data-travelling]').forEach(record => record.removeAttribute('data-travelling'));
      motion.current = null;
      gsap.set(element.querySelectorAll('[data-linked-flip]'), {clearProps: flipStyles});
      gsap.set(element.querySelectorAll('.linked-focus-layer,.linked-quality-content,.linked-overview-heading'), {clearProps: 'opacity'});
    })});
    motion.current = tl;
    const visibleRecords = [...element.querySelectorAll<HTMLElement>('.linked-record')].filter(record => record.style.display !== 'none');
    const isSubject = (record: HTMLElement) => record.dataset.conversationId === transition.previous || record.dataset.conversationId === transition.next;
    tl.add(Flip.from(transition.state, {duration: .56, ease: 'power3.inOut', nested: true,
      absolute: visibleRecords.filter(record => !isSubject(record)), prune: true}), 0);
    tl.add(Flip.from(transition.travel, {duration: .7, ease: 'power3.inOut', nested: true,
      absolute: visibleRecords.filter(isSubject), prune: true}), .12);
    // The renderer lays out once at its final dimensions. Flip scales the whole
    // chart surface instead of asking G2 to redraw axes at every animation frame.
    tl.add(Flip.from(transition.chart, {duration: .82, ease: 'power3.inOut', scale: true}), 0);
    tl.to(element.querySelector('.linked-overview-heading'), {opacity: conversation ? 0 : 1, duration: .2}, conversation ? 0 : .4);
    tl.to(element.querySelector('.linked-focus-layer'), {opacity: conversation ? 1 : 0, duration: .36, ease: 'power2.out'}, .24);
    tl.to(element.querySelector('.linked-quality-content'), {opacity: conversation ? 1 : 0, duration: .28}, .48);
  }, [conversation]);

  useEffect(() => {
    if (reduced || paused) settle();
  }, [reduced, paused]);
  useEffect(() => {
    const resize = () => {settle(); scrollRef.current?.lenis?.resize();};
    window.addEventListener('resize', resize);
    return () => {window.removeEventListener('resize', resize); motion.current?.kill();};
  }, []);

  const visibleByGroup: Record<LinkedGroup, ConversationRow[]> = {
    running: groups.running.filter(row => row.id !== conversation),
    idle: groups.idle.filter(row => row.id !== conversation),
    unknown: groups.unknown.filter(row => row.id !== conversation),
  };
  const placements = new Map<string, {row: number; column: number | string; visible: boolean}>();
  const tracks: string[] = ['minmax(var(--linked-heading-height),auto)', 'var(--linked-chart-height)', '32px'];
  const headers: {group: LinkedGroup; row: number}[] = [];
  const emptyGroups: {group: LinkedGroup; row: number}[] = [];
  let gridRow = 4;
  if (!groupedView) {
    const remaining = rows.filter(row => row.id !== conversation);
    for (let i = 0; i < remaining.length; i += 2) {
      tracks.push('minmax(var(--linked-row-height),auto)');
      remaining.slice(i, i + 2).forEach((row, column) => placements.set(row.id, {row: gridRow, column: column + 1, visible: true}));
      gridRow += 1;
    }
  } else {
    for (const group of ['running', 'idle', 'unknown'] as const) {
      if (group !== 'running' && openGroups[group]) {headers.push({group, row: gridRow++}); tracks.push('38px');}
      const visible = openGroups[group];
      const groupRows = visibleByGroup[group];
      if (visible) for (let i = 0; i < groupRows.length; i += 2) {
        tracks.push('minmax(var(--linked-row-height),auto)');
        groupRows.slice(i, i + 2).forEach((row, column) => placements.set(row.id, {row: gridRow, column: column + 1, visible: true}));
        gridRow += 1;
      }
      if (visible && !groupRows.length && !(group === 'running' && selectedRow && runningIds.has(selectedRow.id))) {
        emptyGroups.push({group, row: gridRow++}); tracks.push('54px');
      }
    }
  }

  const toggle = (group: LinkedGroup) => {
    settle();
    onToggleGroup(group);
    // Native scroll position is preserved; only an explicit selection goes to top.
    requestAnimationFrame(() => scrollRef.current?.lenis?.resize());
  };
  const activeCountText = `${actualRunning} 运行中${waitingRecords ? ` · ${waitingRecords} 待确认` : ''}`;
  return <main ref={root} className={`linked-workspace${selectedRow ? ' is-focused' : ''}`} data-selected={conversation ?? ''} data-moving="false"
    style={{gridTemplateRows: tracks.join(' ')} as CSSProperties}>
    <div className="linked-overview-heading" aria-hidden={!!selectedRow} data-linked-flip data-flip-id="overview-heading">
      <div><span className="linked-kicker">近 30 分钟 · 按完成记录聚焦</span><h1>输出趋势</h1></div>
      <Tooltip title="运行数只计已确认的运行状态；暂缺日志的对话原位保留，单独显示待确认。"><div className="linked-live-count"><strong>{actualRunning}</strong><span>运行中{waitingRecords > 0 && <small> · {waitingRecords} 待确认</small>}</span></div></Tooltip>
    </div>
    <section className="linked-chart" data-linked-flip data-flip-id="comparison-chart" aria-label="同一时间和量程的近期输出趋势">
      <div className="linked-axis-caption"><span>TPS · 完成输出估算</span><span>{selectedRow ? '突出当前对话 · 保留对照' : '同一标尺比较运行中的对话'}</span></div>
      <div className="linked-plot-plane" data-business-empty={!available || (selectedRow ? !hasFocusReadings : !traces.some(trace => trace.points.some(point => point.tps !== null && !point.exclusion))) || undefined}>
        <div className="linked-comparison-base"><LinkedTrendPlot traces={traces} domain={domain} muted={!!selectedRow}/></div>
        <div className="linked-focus-layer" aria-hidden={!selectedRow}><LinkedTrendPlot traces={focused} domain={domain} focus/></div>
        {(!available || (selectedRow ? !hasFocusReadings : !traces.some(trace => trace.points.some(point => point.tps !== null && !point.exclusion)))) && <div className="linked-no-history">
          <strong>{!available ? '统计暂不可用' : focusPoints.length ? '暂无可靠计时' : '近30分钟暂无完成输出'}</strong>
          <span>{!available ? '等待本机记录恢复。' : focusPoints.length ? '缺测时刻保留在下方，不计为零。' : '有完成记录后，近期趋势会在这里显示。'}</span>
        </div>}
      </div>
      <div className="linked-quality-strip">
        {!selectedRow && <span className="linked-overview-note">点选对话，查看同一时间轴上的记录。</span>}
        <div className="linked-quality-content" aria-hidden={!selectedRow}>
          {selectedRow && <><span className="linked-quality-label">记录</span><ProductionQualityTrack points={focusPoints} bounds={domain.x}/>
            <Tooltip title={`${focusHistory?.validCount ?? 0} 次有效，${focusHistory?.excludedCount ?? 0} 次缺测。点为真实完成读数，叉为缺测时刻；金色细虚线仅连接缺测两端，不补造数据。`}><InfoCircleOutlined/></Tooltip></>}
        </div>
      </div>
      {selectedRow && <div className="linked-chart-evidence"><span>{chartProfile && rowProfileId(selectedRow) !== chartProfile.id ? `曲线：${profileLabel(chartProfile)}` : '近30分钟 · 仅同配置记录'}</span><Button type="text" onClick={onDetails} aria-label={`查看 ${selectedRow.label} 的完整记录与配置`}>记录与配置 <RightOutlined/></Button></div>}
    </section>
    <div className="linked-index-caption" data-linked-flip data-flip-id="conversation-caption">
      {groupedView ? <Button type="text" className="linked-running-toggle group-toggle" data-group="running" aria-expanded={openGroups.running} onClick={() => toggle('running')}>
        <RightOutlined rotate={openGroups.running ? 90 : 0}/>{selectedRow ? '继续切换' : '正在运行'} <b>{visibleByGroup.running.length}</b>
      </Button> : <span>固定顺序 <b>{rows.length - (selectedRow ? 1 : 0)}</b></span>}
      <Tooltip title={`最新读数属于最近完成输出配置；均值统计${periodLabels[period]}同配置的有效记录。缺测不补零、不计入均值。`}><span>最近完成 / {periodLabels[period]}均值</span></Tooltip>
    </div>
    {rows.map((row, index) => {
      const selected = row.id === conversation;
      const place = placements.get(row.id);
      const visible = selected || !!place?.visible;
      const profile = row.latest ? row.outputProfile : row.currentProfile;
      const tier = compactSpeed(profile);
      const changed = !!(row.currentProfile && row.latest && row.currentProfile.id !== row.latest.profileId);
      const waiting = pendingRunning.has(row.id);
      const placement = reorder.target?.id === row.id ? reorder.target.placement : null;
      const reading = latestReading(row, available);
      return <article key={row.id} className={`linked-record${selected ? ' is-current' : ''}${reorder.draggingId === row.id ? ' is-dragging' : ''}${placement ? ` drop-${placement}` : ''}`}
        data-conversation-id={row.id} data-card-id={row.id} data-linked-flip data-flip-id={`record-${row.id}`} data-drop-placement={placement || undefined}
        style={{'--trace': traceColor(row.id), gridRow: selected ? 1 : place?.row, gridColumn: selected ? '1 / -1' : place?.column, display: visible ? undefined : 'none'} as CSSProperties}
        onDragOver={event => reorder.onOver(event, row.id)} onDrop={event => reorder.onDrop(event, row.id)}>
        <Dropdown trigger={['click']} menu={{items: [{key: 'up', label: '向前移动', disabled: index === 0 || !reorder.enabled}, {key: 'down', label: '向后移动', disabled: index === rows.length - 1 || !reorder.enabled}], onClick: ({key}) => reorder.onMove(row.id, key === 'up' ? -1 : 1)}}>
          <Tooltip title="拖动编号调整顺序；Alt + ↑ / ↓"><Button type="text" className="linked-order conversation-drag-handle" draggable={reorder.enabled} aria-disabled={!reorder.enabled} aria-label={`调整 ${row.label} 的顺序`} aria-describedby="conversation-order-hint" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onDragStart={event => {settle(); reorder.onStart(event, row.id);}} onDragEnd={reorder.onEnd} onKeyDown={event => reorder.onKey(event, row.id)}>{String(index + 1).padStart(2, '0')}</Button></Tooltip>
        </Dropdown>
        <Dropdown trigger={['contextMenu']} menu={{items: [{key: 'copy', label: '复制完整名称', icon: <CopyOutlined/>}], onClick: () => onCopyName(row.label)}}>
          <Button type="text" className="linked-select conversation-row" onClick={() => choose(selected ? null : row.id)} aria-label={`${selected ? '收起' : '查看'} ${row.label} 的输出趋势`} aria-pressed={selected} aria-expanded={selected}>
            <span className="linked-marker" data-linked-flip data-flip-id={`marker-${row.id}`} aria-hidden="true"/>
            <span className="linked-identity"><Tooltip title={row.label} placement="topLeft" mouseEnterDelay={.35}><span className="linked-name" data-linked-flip data-flip-id={`name-${row.id}`}>{row.label}</span></Tooltip>
              <span className="linked-meta" data-linked-flip data-flip-id={`meta-${row.id}`}><span className={`linked-state state-${row.state}`}>{waiting ? '等待记录' : stateLabel(row)}</span>
                <Tooltip title={profile ? profileLabel(profile) : '尚无配置记录'}><span>{profile?.model || '模型未知'} · {profile?.effort || '强度未知'}</span></Tooltip>
                <Tooltip title={tier.title}><em data-tier-evidence={tier.source}>{tier.source === 'unknown' ? '档位 —' : tier.label}</em></Tooltip>
                {changed && <Tooltip title={`配置已变；当前 ${profileLabel(row.currentProfile!)}。最近读数仍属于完成输出的配置。`}><InfoCircleOutlined aria-label="配置已变"/></Tooltip>}
              </span>
            </span>
            <span className="linked-values" data-linked-flip data-flip-id={`values-${row.id}`}><strong className={reading === '待测' ? 'pending' : reading.length > 6 ? 'is-long-reading' : undefined} data-linked-flip data-flip-id={`number-${row.id}`}>{reading}</strong><span>均值 <b>{numeric(available ? row.average : null)}</b></span></span>
          </Button>
        </Dropdown>
        {waiting && <Dropdown trigger={['click']} menu={{items: [{key: 'transfer', label: '移至待确认区'}], onClick: () => onPendingDismiss(row.id)}}><Tooltip title="暂时未收到新记录，卡片原位保留。点击可手动移至待确认区。"><Button type="text" className="linked-pending-action" icon={<DownOutlined/>} aria-label={`${row.label} 等待记录，点击管理`}/></Tooltip></Dropdown>}
      </article>;
    })}
    {headers.map(({group, row}) => <Button type="text" key={`heading-${group}`} className={`linked-group-heading group-toggle group-${group}`} style={{gridRow: row}} data-group={group} data-linked-flip data-flip-id={`group-${group}`} aria-expanded={openGroups[group]} onClick={() => toggle(group)}>
      <span><RightOutlined rotate={openGroups[group] ? 90 : 0}/>{groupNames[group]} <b>{groups[group].length}</b></span><span>{openGroups[group] ? '收起' : '展开'}</span>
    </Button>)}
    {emptyGroups.map(({group, row}) => <div key={`empty-${group}`} className="linked-group-empty" style={{gridRow: row}}>{group === 'running' ? '当前没有正在运行的对话' : '这里暂时没有对话'}</div>)}
    {!groupedView && !rows.length && <div className="linked-group-empty" style={{gridRow: 4}}>这里暂时没有对话</div>}
    <span className="sr-only" role="status">{selectedRow ? `正在查看 ${selectedRow.label}；最近完成 ${latestReading(selectedRow, available)} TPS。` : activeCountText}</span>
  </main>;
});
const rowProfileId = (row: ConversationRow) => row.outputProfile?.id ?? row.currentProfile?.id;
const runningIdsForColor = (groups: Record<LinkedGroup, ConversationRow[]>, id: string) => groups.running.some(row => row.id === id);
export default LinkedWorkspace;
