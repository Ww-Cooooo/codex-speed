import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { Button, ConfigProvider, Dropdown, Modal, Select, Tooltip, theme } from 'antd';
import { ArrowLeftOutlined, BorderOutlined, CloseOutlined, CopyOutlined, DownOutlined, EllipsisOutlined, HolderOutlined, InfoCircleOutlined, LineChartOutlined, MinusOutlined, PushpinFilled, PushpinOutlined, UpOutlined } from '@ant-design/icons';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { ReactLenis, type LenisRef } from 'lenis/react';
import type { DesktopState, ProfileView, SampleView, Snapshot } from './contracts';
import {type DropTarget, type ReorderControls} from './ConversationCard';
import LinkedWorkspace, {type LinkedWorkspaceHandle} from './LinkedWorkspace';
import { createDemoSnapshot } from './demo';
import {dismissPendingRunning, receiveMonitorView, type MonitorView} from './monitor-view';
import { compactSpeed, conversationStateLabels, deriveOverview, deriveScope, effortLabel, isRunning, isValidSample, mergeConversationOrder, moveConversation, orderConversationRows, periodLabels, profileLabel, speedLabel, splitConversationRows, type ConversationRow, type Period } from './statistics';
import './styles.css';
import 'lenis/dist/lenis.css';

gsap.registerPlugin(useGSAP);
const SpeedHistory = lazy(() => import('./SpeedHistory').then((module) => ({ default: module.SpeedHistory })));
const COLLAPSED = 144;
const DEFAULT_EXPANDED_SIZE = { width: 600, height: 640 };
const compactOverlayHeight = (height: number) => Math.min(height, 280);
const formatTps = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(1) : '—';
const clock = (value: string, now: number) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return `${sameDay ? '' : `${date.getMonth() + 1}/${date.getDate()} `}${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
};
const fallbackSnapshot = (status: Snapshot['status'], message: string): Snapshot => ({ schemaVersion: 3, mode: 'live', status, message, updatedAt: new Date().toISOString(), activeProfile: null, profiles: [], samples: [], conversations: [] });
const UNKNOWN_SPEED = '本地记录未提供可识别档位，不代表未开启 Fast。';
const ORDER_MIME = 'application/x-codex-tps-conversation';
const ORDER_LIMIT = 10_512;
type Group = 'running' | 'idle' | 'unknown';
const stateLabel = (row: ConversationRow) => row.state === 'idle' ? '未运行' : row.state === 'unknown' ? '状态待确认' : conversationStateLabels[row.state];
const compactModel = (model?: string | null) => model ? model.replace(/^gpt[- ]/i, '').replace(/-/g, ' ') : '未知';
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

function Configuration({ profile, prefix }: { profile?: ProfileView; prefix?: string }) {
  const unknown = !profile?.requestedTier && !profile?.actualTier && !profile?.submittedTier;
  return <span className="row-configuration">
    {prefix && <span className="configuration-prefix">{prefix}</span>}
    <Tooltip title={profile?.model || '本地记录未提供模型名称'} placement="topLeft"><span className="row-model">{profile?.model || '模型未知'}</span></Tooltip>
    <span className="row-tags"><span>{effortLabel(profile)}</span><i>·</i><Tooltip title={unknown ? UNKNOWN_SPEED : profile?.actualTier ? '已从记录识别实际处理档位。' : profile?.requestedTier ? '这是记录中的请求档位，实际处理档位尚未确认。' : '提交设置，实际处理档位未确认。'} placement="topLeft"><span className={unknown ? 'tier-unknown' : 'tier-known'}>{speedLabel(profile)}</span></Tooltip></span>
  </span>;
}

export default function App() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const demo = params.get('demo') === '1';
  const bridge = window.tps;
  const [monitorView, setMonitorView] = useState<MonitorView>(() => ({snapshot: demo && !bridge ? createDemoSnapshot(params.get('fixture') || '') : fallbackSnapshot('waiting', '正在连接本机统计'), pendingRunningIds: [], retainedUnknownIds: [], cached: false}));
  const snapshot = monitorView.snapshot;
  const setSnapshot = (value: Snapshot) => setMonitorView(previous => receiveMonitorView(previous, value));
  const pendingRunning = useMemo(() => new Set(monitorView.pendingRunningIds), [monitorView.pendingRunningIds]);
  const groupFor = (row: ConversationRow): Group => isRunning(row.state) || pendingRunning.has(row.id) ? 'running' : row.state === 'unknown' ? 'unknown' : 'idle';
  const [desktopState, setDesktopState] = useState<DesktopState>({ pinned: false, expanded: params.get('expanded') !== '0', maximized: false, conversationOrder: [], expandedSize: DEFAULT_EXPANDED_SIZE });
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [conversation, setConversation] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('today');
  const [showSubagents, setShowSubagents] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [pinPending, setPinPending] = useState(false);
  const [maximizePending, setMaximizePending] = useState(false);
  const [controlError, setControlError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copiedName, setCopiedName] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<Group, boolean>>({ running: true, idle: false, unknown: false });
  const [groupedView, setGroupedView] = useState(true);
  const [conversationOrder, setConversationOrder] = useState<string[]>([]);
  const [orderReady, setOrderReady] = useState(!bridge);
  const [orderPersistenceAvailable, setOrderPersistenceAvailable] = useState(false);
  const [orderPending, setOrderPending] = useState(false);
  const [orderWarning, setOrderWarning] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const panel = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const detailScroll = useRef<HTMLDivElement>(null);
  const overviewScroll = useRef<LenisRef>(null);
  const linkedWorkspace = useRef<LinkedWorkspaceHandle>(null);
  const focusedConversation = useRef<string | null>(null);
  const focusedHandle = useRef(false);
  const initializedOrder = useRef(!bridge);
  const latestOrder = useRef<string[]>([]);
  const savedOrderKey = useRef('');
  const attemptedOrderKey = useRef('');
  const dragSession = useRef<string | null>(null);
  const dragTarget = useRef<DropTarget | null>(null);
  const suppressOpenUntil = useRef(0);
  const restoreSelectionFocus = useRef<string | null>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const currentHeight = useRef(window.innerHeight);
  const nativeTransition = useRef(false);
  const pendingNativeCompletion = useRef(false);
  const expandedSize = useRef(DEFAULT_EXPANDED_SIZE);
  const previousExpanded = useRef<boolean | null>(null);
  const overlayOpen = useRef(false);
  const expandRequest = useRef(0);
  const interactionRevision = useRef(0);
  const reduced = useReducedMotion();
  const expanded = desktopState.expanded;
  expandedSize.current = desktopState.expandedSize;
  const scrollOptions = useMemo(() => ({ autoRaf: expanded && !reduced, smoothWheel: expanded && !reduced, lerp: 0.16, overscroll: false }), [expanded, reduced]);

  function captureReadingLayout() {
    if (!panel.current) return;
    const focused = document.activeElement?.closest<HTMLElement>('[data-conversation-id]');
    focusedConversation.current = focused?.dataset.conversationId || null;
    focusedHandle.current = Boolean(document.activeElement?.closest('.conversation-drag-handle'));
  }

  useEffect(() => {
    const update = () => { captureReadingLayout(); setNow(Date.now()); };
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);

  useEffect(() => {
    const resize = () => {
      setViewportHeight(window.innerHeight);
      if (!nativeTransition.current) currentHeight.current = window.innerHeight;
      overviewScroll.current?.lenis?.resize();
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);


  useEffect(() => {
    if (!bridge) {
      if (!demo) setSnapshot(fallbackSnapshot('unavailable', '请从桌面启动入口打开'));
      return;
    }
    let active = true;
    const receive = (value: Snapshot) => {
      if (!active) return;
      if (value.schemaVersion !== 3 || !Array.isArray(value.profiles) || !Array.isArray(value.samples) || !Array.isArray(value.conversations) || !Number.isFinite(Date.parse(value.updatedAt))) {
        setSnapshot(fallbackSnapshot('error', '统计数据格式暂不兼容'));
        return;
      }
      captureReadingLayout();
      setNow(Date.now());
      setSnapshot(value);
    };
    const unsubscribe = bridge.onSnapshot(receive);
    const unsubscribeState = bridge.onState((state) => {
      if (!active) return;
      interactionRevision.current += 1;
      setDesktopState(state);
    });
    bridge.getSnapshot().then((value) => { if (value) receive(value); }).catch(() => { if (active) setSnapshot(fallbackSnapshot('error', '桌面连接暂时不可用')); });
    const syncState = () => {
      const revision = interactionRevision.current;
      bridge.getState().then((state) => {
        if (!active) return;
        if (!initializedOrder.current) {
          initializedOrder.current = true;
          setConversationOrder(state.conversationOrder);
          savedOrderKey.current = state.conversationOrder.join(',');
          attemptedOrderKey.current = savedOrderKey.current;
          setOrderPersistenceAvailable(true);
          setOrderReady(true);
        }
        // Focus synchronization never replaces the session's established rank.
        if (revision === interactionRevision.current) setDesktopState(state);
      }).catch(() => {
        if (!active) return;
        if (!initializedOrder.current) {
          initializedOrder.current = true;
          setOrderReady(true);
          setOrderWarning('未读到排序设置，当前顺序仅本次有效；重开可重试。');
        } else setControlError('窗口设置暂时不可用');
      });
    };
    syncState();
    window.addEventListener('focus', syncState);
    return () => { active = false; unsubscribe(); unsubscribeState(); window.removeEventListener('focus', syncState); };
  }, [bridge, demo]);

  useEffect(() => { if (!expanded) { setProfileOpen(false); setPeriodOpen(false); setChartOpen(false); setDetailsOpen(false); } }, [expanded]);
  useEffect(() => { setChartOpen(false); setDetailsOpen(false); setCopiedName(false); }, [conversation]);
  useEffect(() => {
    const wasOpen = overlayOpen.current;
    overlayOpen.current = menuOpen || profileOpen || periodOpen;
    // Expanded overlays already have the full viewport. Only the compact tray
    // needs temporary native space, and it must return to compact height.
    if (!expanded && (overlayOpen.current || wasOpen)) bridge?.resizeHeight(overlayOpen.current ? compactOverlayHeight(expandedSize.current.height) : COLLAPSED, true);
  }, [menuOpen, profileOpen, periodOpen, expanded, bridge]);

  useGSAP(() => {
    if (!panel.current || !workspace.current || !orderReady) return;
    timeline.current?.kill();
    if (desktopState.maximized) {
      nativeTransition.current = false;
      pendingNativeCompletion.current = false;
      currentHeight.current = window.innerHeight;
      previousExpanded.current = expanded;
      gsap.set(workspace.current, { autoAlpha: expanded ? 1 : 0, y: 0 });
      return;
    }
    const firstPresentation = previousExpanded.current === null;
    const changed = !firstPresentation && previousExpanded.current !== expanded;
    previousExpanded.current = expanded;
    if (!changed) {
      // The native window has already restored its saved bounds. First paint
      // and reduced-motion changes reveal content without resizing that window.
      currentHeight.current = window.innerHeight;
      gsap.set(workspace.current, { autoAlpha: expanded ? 1 : 0, y: 0 });
      if (pendingNativeCompletion.current) {
        const finishedHeight = expanded ? expandedSize.current.height : overlayOpen.current ? compactOverlayHeight(expandedSize.current.height) : COLLAPSED;
        currentHeight.current = finishedHeight;
        bridge?.resizeHeight(finishedHeight, true);
        pendingNativeCompletion.current = false;
      }
      if (firstPresentation && expanded && !reduced) {
        const reveal = gsap.timeline().fromTo(workspace.current, { autoAlpha: 0, y: 5 }, { autoAlpha: 1, y: 0, duration: .19, ease: 'power1.out' });
        timeline.current = reveal;
        return () => { reveal.kill(); };
      }
      return;
    }
    const target = expanded ? expandedSize.current.height : COLLAPSED;
    const driver = { height: currentHeight.current };
    nativeTransition.current = true;
    pendingNativeCompletion.current = true;
    const resize = (finished = false) => {
      currentHeight.current = driver.height;
      bridge?.resizeHeight(!expanded && overlayOpen.current ? compactOverlayHeight(expandedSize.current.height) : Math.round(driver.height), finished);
      if (finished) { nativeTransition.current = false; pendingNativeCompletion.current = false; }
    };
    if (reduced) { driver.height = target; gsap.set(workspace.current, { autoAlpha: expanded ? 1 : 0, y: 0 }); resize(true); return; }
    const sequence = gsap.timeline({ onUpdate: () => resize(), onComplete: () => resize(true) });
    timeline.current = sequence;
    if (expanded) sequence.to(driver, { height: target, duration: 0.31, ease: 'power2.out' }, 0).to(workspace.current, { autoAlpha: 1, y: 0, duration: 0.19, ease: 'power1.out' }, 0.08);
    else sequence.to(workspace.current, { autoAlpha: 0, y: 5, duration: 0.12, ease: 'power1.out' }, 0).to(driver, { height: target, duration: 0.25, ease: 'power2.inOut' }, 0.025);
    return () => { sequence.kill(); nativeTransition.current = false; };
  }, { scope: panel, dependencies: [expanded, desktopState.maximized, reduced, orderReady], revertOnUpdate: false });

  const observedRows = useMemo(() => deriveOverview(snapshot, period, now, showSubagents, conversation), [snapshot, period, now, showSubagents, conversation]);
  const discoveredIds = useMemo(() => [...new Set([...snapshot.conversations.map((item) => item.id), ...snapshot.samples.map((item) => item.conversationId)])], [snapshot.conversations, snapshot.samples]);
  const effectiveOrder = useMemo(() => mergeConversationOrder(conversationOrder, discoveredIds), [conversationOrder, discoveredIds]);
  const orderKey = effectiveOrder.join(',');
  latestOrder.current = effectiveOrder;
  const rows = useMemo(() => orderConversationRows(observedRows, effectiveOrder), [observedRows, effectiveOrder]);
  const groups = useMemo(() => {
    const result = splitConversationRows(rows, effectiveOrder);
    return {...result, running: rows.filter(row => isRunning(row.state) || pendingRunning.has(row.id)),
      unknown: result.unknown.filter(row => !pendingRunning.has(row.id))};
  }, [rows, effectiveOrder, pendingRunning]);
  useEffect(() => {
    if (orderReady) setConversationOrder((previous) => previous.join(',') === orderKey ? previous : effectiveOrder);
  }, [orderKey, orderReady]);

  useEffect(() => {
    if (!bridge || !orderReady || !orderPersistenceAvailable || orderPending || draggingId || !orderKey) return;
    if (orderKey === savedOrderKey.current) {
      attemptedOrderKey.current = orderKey;
      setOrderWarning('');
      return;
    }
    if (orderKey === attemptedOrderKey.current) return;
    // New IDs and deliberate moves write once per changed rank, never per poll.
    // A failed sequence remains usable in-session and is not retried unchanged.
    attemptedOrderKey.current = orderKey;
    if (effectiveOrder.length > ORDER_LIMIT) {
      setOrderWarning('对话较多，当前顺序仅本次有效。');
      return;
    }
    setOrderPending(true);
    setOrderWarning('');
    bridge.setConversationOrder(effectiveOrder).then((state) => {
      savedOrderKey.current = state.conversationOrder.join(',');
      setDesktopState((previous) => ({ ...previous, conversationOrder: state.conversationOrder }));
      setOrderWarning('');
    }).catch(() => setOrderWarning('顺序未保存，当前调整仅本次有效。')).finally(() => setOrderPending(false));
  }, [orderKey, orderReady, orderPersistenceAvailable, orderPending, draggingId, bridge]);
  useEffect(() => {
    if (conversation && !rows.some((item) => item.id === conversation)) {
      setConversation(null);
      setSelectedProfile(null);
    }
  }, [conversation, rows]);
  const runningCount = rows.filter((row) => isRunning(row.state)).length;
  const pendingCount = rows.filter(row => pendingRunning.has(row.id)).length;
  const row = rows.find((item) => item.id === conversation);
  const scope = useMemo(() => deriveScope(snapshot, conversation, period, now, selectedProfile), [snapshot, conversation, period, now, selectedProfile]);
  const chartProfile = scope.profile || row?.outputProfile || row?.currentProfile;
  const chartSamples = useMemo(() => snapshot.samples.filter((sample) => sample.conversationId === conversation && sample.profileId === chartProfile?.id), [snapshot.samples, conversation, chartProfile?.id]);
  const isAvailable = monitorView.cached || (snapshot.status !== 'error' && snapshot.status !== 'unavailable');
  const compactLatest = [...rows].filter((item) => item.latest).sort((a, b) => Date.parse(b.latest!.completedAt) - Date.parse(a.latest!.completedAt))[0];
  const noBridge = !bridge && !demo;
  const requestedUnconfirmed = Boolean((scope.profile?.requestedTier || scope.profile?.submittedTier) && !scope.profile.actualTier);
  const detailLatestReading = formatTps(isAvailable && scope.latest && isValidSample(scope.latest) ? scope.latest.tps : null);
  const historyByConversation = useMemo(() => {
    const histories = new Map<string, SampleView[]>();
    for (const sample of snapshot.samples) {
      const key = `${sample.conversationId}:${sample.profileId}`;
      const list = histories.get(key);
      if (list) list.push(sample); else histories.set(key, [sample]);
    }
    return histories;
  }, [snapshot.samples]);

  useLayoutEffect(() => {
    if (detailScroll.current) detailScroll.current.scrollTop = 0;
  }, [conversation, selectedProfile, period]);

  useLayoutEffect(() => {
    const id = restoreSelectionFocus.current || focusedConversation.current;
    restoreSelectionFocus.current = null;
    focusedConversation.current = null;
    if (!id || !panel.current) return;
    if (document.activeElement?.closest<HTMLElement>('[data-conversation-id]')?.dataset.conversationId === id) return;
    const target = rows.find((item) => item.id === id);
    if (!target) return;
    const group = groupFor(target);
    const button = !groupedView || openGroups[group]
      ? panel.current.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(id)}"] ${focusedHandle.current ? '.conversation-drag-handle' : '.conversation-row'}`)
      : panel.current.querySelector<HTMLElement>(`.linked-state-toggle[data-group="${group}"],.group-toggle[data-group="${group}"]`);
    button?.focus({ preventScroll: true });
  }, [rows, openGroups, conversation, groupedView]);

  const openConversation = (id: string) => {
    if (dragSession.current || Date.now() < suppressOpenUntil.current) return;
    if (conversation === id) { closeConversation(); return; }
    captureReadingLayout();
    setConversation(id);
    setSelectedProfile(null);
  };
  const closeConversation = () => {
    captureReadingLayout();
    restoreSelectionFocus.current = conversation;
    setConversation(null);
    setSelectedProfile(null);
    setProfileOpen(false);
    setDetailsOpen(false);
  };
  const toggleGroup = (group: Group) => {
    captureReadingLayout();
    setOpenGroups((previous) => ({ ...previous, [group]: !previous[group] }));
    if (openGroups[group] && group !== 'running') requestAnimationFrame(() => {
      panel.current?.querySelector<HTMLElement>(`.linked-state-toggle[data-group="${group}"]`)?.focus({preventScroll: true});
    });
  };
  const navigateGroup = (group: 'idle' | 'unknown') => {
    toggleGroup(group);
    requestAnimationFrame(() => {
      const scroll = overviewScroll.current;
      scroll?.lenis?.resize();
      const heading = panel.current?.querySelector<HTMLElement>(`.linked-workspace .group-toggle[data-group="${group}"]`);
      if (!openGroups[group] && heading) scroll?.lenis?.scrollTo(heading, {immediate: reduced, duration: .5});
    });
  };

  const canReorder = orderReady && !orderPending;
  const inSameVisibleGroup = (source: string, target: string) => {
    if (!groupedView) return true;
    const sourceRow = rows.find((item) => item.id === source);
    const targetRow = rows.find((item) => item.id === target);
    return Boolean(sourceRow && targetRow && groupFor(sourceRow) === groupFor(targetRow) && openGroups[groupFor(sourceRow)]);
  };
  const finishDrag = () => {
    dragSession.current = null;
    dragTarget.current = null;
    suppressOpenUntil.current = Date.now() + 100;
    setDraggingId(null);
    setDropTarget(null);
  };
  const commitOrder = (next: string[], id: string) => {
    if (next.join(',') === latestOrder.current.join(',')) return;
    captureReadingLayout();
    restoreSelectionFocus.current = id;
    focusedHandle.current = true;
    interactionRevision.current += 1;
    setConversationOrder(next);
  };
  const startDrag = (event: DragEvent<HTMLElement>, id: string) => {
    if (!canReorder) { event.preventDefault(); return; }
    captureReadingLayout();
    const scroll = overviewScroll.current;
    if (scroll?.lenis && scroll.wrapper) scroll.lenis.scrollTo(scroll.wrapper.scrollTop, { immediate: true });
    dragSession.current = id;
    dragTarget.current = null;
    suppressOpenUntil.current = Number.POSITIVE_INFINITY;
    setDraggingId(id);
    setDropTarget(null);
    event.dataTransfer.clearData();
    event.dataTransfer.setData(ORDER_MIME, id);
    event.dataTransfer.effectAllowed = 'move';
    const item = event.currentTarget.closest<HTMLElement>('[data-conversation-id]');
    if (item) event.dataTransfer.setDragImage(item, 17, 35);
  };
  const internalDrag = (event: DragEvent<HTMLElement>) => Boolean(dragSession.current && event.dataTransfer.types.includes(ORDER_MIME));
  const dragPlacement = (event: DragEvent<HTMLElement>): DropTarget['placement'] => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.currentTarget.classList.contains('linked-record')
      ? event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after'
      : event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
  };
  const hoverDrag = (event: DragEvent<HTMLElement>, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (!internalDrag(event) || !canReorder || !inSameVisibleGroup(dragSession.current!, id)) { event.dataTransfer.dropEffect = 'none'; dragTarget.current = null; setDropTarget(null); return; }
    event.dataTransfer.dropEffect = 'move';
    const placement = dragPlacement(event);
    if (dragTarget.current?.id === id && dragTarget.current.placement === placement) return;
    dragTarget.current = { id, placement };
    setDropTarget(dragTarget.current);
  };
  const dropDrag = (event: DragEvent<HTMLElement>, id: string) => {
    event.preventDefault();
    event.stopPropagation();
    const source = dragSession.current;
    // Never read files or data from an external drag. The custom payload must
    // match a drag initiated by this exact renderer's dedicated handle.
    if (!source || !internalDrag(event) || !canReorder || !inSameVisibleGroup(source, id) || event.dataTransfer.getData(ORDER_MIME) !== source) { finishDrag(); return; }
    const placement = dragTarget.current?.id === id ? dragTarget.current.placement : dragPlacement(event);
    commitOrder(moveConversation(latestOrder.current, source, id, placement), source);
    finishDrag();
  };
  const keyReorder = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (event.key === 'Escape' && dragSession.current) { finishDrag(); return; }
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!canReorder) return;
    const source = rows.find((item) => item.id === id);
    const visibleRows = groupedView && source ? groups[groupFor(source)] : rows;
    const index = visibleRows.findIndex((item) => item.id === id);
    const target = visibleRows[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (target) commitOrder(moveConversation(latestOrder.current, id, target.id, event.key === 'ArrowUp' ? 'before' : 'after'), id);
  };
  const manualMove = (id: string, direction: -1 | 1) => {
    if (!canReorder) return;
    const source = rows.find(item => item.id === id);
    const visibleRows = groupedView && source ? groups[groupFor(source)] : rows;
    const index = visibleRows.findIndex(item => item.id === id);
    const target = visibleRows[index + direction];
    if (target) commitOrder(moveConversation(latestOrder.current, id, target.id, direction === -1 ? 'before' : 'after'), id);
  };
  const reorder: ReorderControls = { enabled: canReorder, draggingId, target: dropTarget, onStart: startDrag, onEnd: finishDrag, onOver: hoverDrag, onDrop: dropDrag, onKey: keyReorder, onMove: manualMove };

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !dragSession.current) return;
      event.preventDefault();
      finishDrag();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);

  useEffect(() => {
    if (draggingId && !rows.some((item) => item.id === draggingId)) finishDrag();
  }, [rows, draggingId]);

  const toggleExpanded = () => {
    const next = !expanded;
    interactionRevision.current += 1;
    const request = ++expandRequest.current;
    const previous = desktopState;
    // Let the native window restore from maximized bounds before starting the
    // compact animation; the restored state is returned by setExpanded.
    if (!desktopState.maximized) setDesktopState((state) => ({ ...state, expanded: next }));
    setControlError('');
    if (bridge) bridge.setExpanded(next).then((state) => { if (request === expandRequest.current) setDesktopState((previous) => ({ ...previous, expanded: state.expanded, maximized: state.maximized, expandedSize: state.expandedSize })); }).catch(() => { if (request === expandRequest.current) { setDesktopState(previous); setControlError('展开设置未保存，请重试'); } });
  };
  const togglePinned = () => {
    if (pinPending) return;
    interactionRevision.current += 1;
    const next = !desktopState.pinned;
    if (!bridge) { if (demo) setDesktopState((state) => ({ ...state, pinned: next })); return; }
    setPinPending(true); setControlError('');
    bridge.setPinned(next).then((state) => setDesktopState((previous) => ({ ...previous, pinned: state.pinned }))).catch(() => setControlError('置顶设置未保存，请重试')).finally(() => setPinPending(false));
  };
  const toggleMaximized = () => {
    if (!bridge || maximizePending) return;
    interactionRevision.current += 1;
    setMaximizePending(true);
    setControlError('');
    setMenuOpen(false);
    bridge.setMaximized(!desktopState.maximized).then((state) => {
      setDesktopState((previous) => ({ ...previous, maximized: state.maximized, expanded: state.expanded, expandedSize: state.expandedSize }));
    }).catch(() => setControlError('窗口大小暂未切换，请重试')).finally(() => setMaximizePending(false));
  };

  const copyName = async (name: string) => {
    try { await navigator.clipboard.writeText(name); setCopiedName(true); }
    catch { setControlError('名称暂未复制，请从完整记录中选择名称复制'); }
  };
  return <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#e3c784', colorText: '#f4f1e9', colorTextSecondary: '#a8b0b1', colorBorder: '#414c4d', colorBgContainer: '#20292a', colorBgElevated: '#263133', fontFamily: 'Noto Sans SC, sans-serif', fontSize: 13, controlHeight: 30, borderRadius: 6 }, components: { Button: { controlHeight: 30, contentFontSize: 13 }, Select: { optionFontSize: 12, optionHeight: 32 }, Tooltip: { colorBgSpotlight: '#f1e4d2', colorTextLightSolid: '#2e251c' } } }}>
    <main data-ui="linked-trends" className={`tps-panel${expanded ? ' is-expanded' : ''}${desktopState.maximized ? ' is-maximized' : ''}${snapshot.mode === 'demo' ? ' is-demo' : ''}`} ref={panel} aria-label="Codex 多对话生成速度" onDragOver={(event) => { if (!internalDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; } }} onDrop={(event) => { event.preventDefault(); finishDrag(); }}>
      <header className="panel-header">
        <Tooltip title={monitorView.cached ? snapshot.message : snapshot.mode === 'demo' ? '示例数据，未读取本机 Codex' : isAvailable ? '本机只读统计' : snapshot.message} placement="bottomLeft"><span className={`status-dot status-${snapshot.status}${snapshot.mode === 'demo' ? ' demo-dot' : ''}`} aria-label={snapshot.mode === 'demo' ? '示例模式' : '本机统计状态'} /></Tooltip>
        <span className="panel-brand">Codex Speed</span><span className="header-count">{runningCount} 运行中{pendingCount > 0 && ` · ${pendingCount} 待确认`}</span>
        {snapshot.mode === 'demo' && <span className="demo-label">示例</span>}
        <div className="window-tools no-drag">
          <Tooltip title={desktopState.pinned ? '取消置顶' : '置顶窗口'} placement="bottom"><Button type="text" className={desktopState.pinned ? 'tool-button pinned' : 'tool-button'} icon={desktopState.pinned ? <PushpinFilled /> : <PushpinOutlined />} aria-label={desktopState.pinned ? '取消置顶' : '置顶窗口'} aria-pressed={desktopState.pinned} loading={pinPending} disabled={noBridge} onClick={togglePinned} /></Tooltip>
          <Tooltip title={expanded ? '收起总览' : '展开全部对话'} placement="bottom"><Button type="text" className="tool-button" icon={expanded ? <UpOutlined /> : <DownOutlined />} onClick={toggleExpanded} disabled={maximizePending} aria-label={expanded ? '收起总览' : '展开全部对话'} aria-expanded={expanded} aria-controls="conversation-workspace" /></Tooltip>
          <Dropdown menu={{ selectable: true, selectedKeys: [...(showSubagents ? ['subagents'] : []), ...(groupedView ? ['grouped'] : [])], items: [{ key: 'grouped', label: groupedView ? '按状态分组 ✓' : '按状态分组' }, { key: 'subagents', label: showSubagents ? '显示子任务 ✓' : '显示子任务' }, { type: 'divider' }, { key: 'hide', label: '隐藏到托盘', disabled: !bridge }, { key: 'quit', label: '退出', disabled: !bridge }], onClick: ({ key }) => { if (key === 'grouped') { captureReadingLayout(); finishDrag(); setGroupedView((value) => !value); } if (key === 'subagents') { captureReadingLayout(); setShowSubagents((value) => !value); } if (key === 'hide') bridge?.hide(); if (key === 'quit') bridge?.quit(); } }} trigger={['click']} open={menuOpen} onOpenChange={setMenuOpen} placement="bottomRight" getPopupContainer={() => document.body}><Button type="text" className="tool-button menu-button" icon={<EllipsisOutlined />} aria-label="窗口菜单" aria-haspopup="menu" aria-expanded={menuOpen} /></Dropdown>
          <div className="standard-window-controls" role="group" aria-label="窗口控制">
            <Tooltip title="最小化到托盘 · 继续统计" placement="bottom"><Button type="text" className="tool-button window-control-button minimize-button" icon={<MinusOutlined />} aria-label="最小化到托盘" disabled={!bridge} onClick={() => bridge?.hide()} /></Tooltip>
            <Tooltip title={desktopState.maximized ? '还原窗口' : '最大化窗口'} placement="bottom"><Button type="text" className="tool-button window-control-button maximize-button" icon={desktopState.maximized ? <CopyOutlined /> : <BorderOutlined />} aria-label={desktopState.maximized ? '还原窗口' : '最大化窗口'} aria-pressed={desktopState.maximized} disabled={!bridge} loading={maximizePending} onClick={toggleMaximized} /></Tooltip>
            <Tooltip title="关闭并退出 · 停止统计" placement="bottomLeft"><Button type="text" className="tool-button window-control-button close-window-button" icon={<CloseOutlined />} aria-label="关闭并退出" disabled={!bridge} onClick={() => bridge?.quit()} /></Tooltip>
          </div>
        </div>
      </header>
      <section className="compact-summary" aria-hidden={expanded} inert={expanded}>
        <span className="compact-label">最近完成 · {compactLatest?.label || '等待输出'}</span>
        <span className="compact-value"><strong>{formatTps(isAvailable && compactLatest?.latest && isValidSample(compactLatest.latest) ? compactLatest.latest.tps : null)}</strong><span>TPS 估算</span></span>
        <span className="compact-caption">{rows.length} 个对话 · 展开后同时查看</span>
      </section>
      <section id="conversation-workspace" ref={workspace} className="workspace" aria-hidden={!expanded} inert={!expanded}>
        <div className="overview-toolbar no-drag">
          <div className="overview-heading"><Button type="text" className="return-trends-button" icon={<ArrowLeftOutlined/>} disabled={!conversation} onClick={() => linkedWorkspace.current?.select(null)} aria-label="返回全部趋势">全部趋势</Button><span>{rows.length} 个对话</span><span className="overview-view-label">{groupedView ? '按状态分组' : '固定顺序'}</span></div>
          <Tooltip title="均值按本机日期筛选；运行中的对话始终保留。" placement="bottomRight"><Select<Period> value={period} aria-label="统计时段" size="small" className="period-select" options={(Object.keys(periodLabels) as Period[]).map((value) => ({ value, label: periodLabels[value] }))} onChange={(value) => { captureReadingLayout(); setPeriod(value); setSelectedProfile(null); }} open={periodOpen} onOpenChange={setPeriodOpen} popupMatchSelectWidth={110} getPopupContainer={() => document.body} /></Tooltip>
        </div>
        <span id="conversation-order-hint" className="sr-only">{groupedView ? '按运行状态分组，组内顺序固定。拖左侧把手，或聚焦把手后用 Alt 加上、下箭头调整同组顺序。' : '顺序固定，状态原地更新。拖左侧把手，或聚焦把手后用 Alt 加上、下箭头调整顺序。'}</span>
        <ReactLenis ref={overviewScroll} className="overview-scroll no-drag" data-list-view={groupedView ? 'grouped' : 'fixed'} options={scrollOptions} onDragOver={(event) => {
          if ((event.target as HTMLElement).closest('[data-conversation-id]')) return;
          event.preventDefault();
          if (!internalDrag(event) || !canReorder || groupedView) { event.dataTransfer.dropEffect = 'none'; dragTarget.current = null; setDropTarget(null); return; }
          event.dataTransfer.dropEffect = 'move';
          const last = rows.at(-1);
          if (last && (dragTarget.current?.id !== last.id || dragTarget.current.placement !== 'after')) {
            dragTarget.current = { id: last.id, placement: 'after' };
            setDropTarget(dragTarget.current);
          }
        }} onDrop={(event) => { const target = dragTarget.current; if (target) dropDrag(event, target.id); else { event.preventDefault(); finishDrag(); } }} tabIndex={0} aria-label="全部对话列表，可上下滚动">
          {!orderReady ? <div className="overview-empty" role="status"><strong>正在读取列表顺序…</strong><span>读回保存的顺序后再显示。</span></div> : <LinkedWorkspace ref={linkedWorkspace}
            rows={rows} groups={groups} groupedView={groupedView} openGroups={openGroups} conversation={conversation}
            onSelect={id => id ? openConversation(id) : closeConversation()} onToggleGroup={toggleGroup}
            period={period} histories={historyByConversation} chartProfile={chartProfile} now={now} available={isAvailable}
            pendingRunning={pendingRunning} reorder={reorder} onDetails={() => setDetailsOpen(true)}
            onCopyName={name => {void copyName(name);}} onPendingDismiss={id => {
              captureReadingLayout(); restoreSelectionFocus.current = id; focusedHandle.current = false;
              setMonitorView(previous => dismissPendingRunning(previous, id));
              requestAnimationFrame(() => {
                panel.current?.querySelector<HTMLElement>('.linked-state-toggle[data-group="unknown"]')?.focus({preventScroll: true});
              });
            }}
            scrollRef={overviewScroll} reduced={reduced} paused={!expanded || detailsOpen}/>}
        </ReactLenis>
        {groupedView && <nav className="linked-state-nav no-drag" aria-label="其他运行状态">
          {(['idle', 'unknown'] as const).map(group => <Button type="text" key={group} className="linked-state-toggle" data-group={group}
            aria-label={`${openGroups[group] ? '收起' : '查看'}${group === 'idle' ? '未运行' : '状态待确认'}对话`} aria-expanded={openGroups[group]} onClick={() => navigateGroup(group)}>
            <DownOutlined rotate={openGroups[group] ? 180 : 0}/>{group === 'idle' ? '未运行' : '状态待确认'} <b>{groups[group].length}</b>
          </Button>)}
        </nav>}
        <Modal className="record-details-modal" open={detailsOpen && Boolean(conversation)} onCancel={() => {setDetailsOpen(false); setChartOpen(false); setProfileOpen(false);}} title="记录与配置" footer={null} width={640} centered styles={{body: {maxHeight: 'calc(100vh - 136px)', overflowY: 'auto', overflowX: 'hidden'}}}>
        {conversation && <div ref={detailScroll} className="detail-scroll no-drag" data-selected-conversation={conversation} aria-label="所选对话的输出详情">
          <div className="detail-heading"><div><h2 title={row?.label}>{row?.label || '对话记录'}</h2><span className={`conversation-state state-${row?.state || 'unknown'}`}>{row ? stateLabel(row) : '状态待确认'}</span></div><Tooltip title={copiedName ? '名称已复制' : '复制完整名称'}><Button type="text" className="copy-name-button" icon={<CopyOutlined/>} onClick={() => {if (row) void copyName(row.label);}} aria-label="复制完整对话名称"/></Tooltip><Button size="small" className="detail-chart-button" icon={<LineChartOutlined />} onClick={() => setChartOpen(true)} aria-label="放大输出速度图表">曲线</Button></div>
          <div className="detail-top">
            <section className="metrics detail-metrics" aria-label="所选对话与配置的速度读数">
              <div className="metric latest-metric"><h2>上次完成 <span className="estimated-label">TPS 估算</span></h2><div className="number-line"><Tooltip title={`${detailLatestReading} TPS · 已完成输出估算`}><strong className={`metric-number primary-number${detailLatestReading.length > 6 ? ` detail-reading-fit-${Math.min(10, detailLatestReading.length)}` : ''}`}>{detailLatestReading}</strong></Tooltip></div><div className="metric-caption">{scope.latest ? `${clock(scope.latest.completedAt, now)}${isValidSample(scope.latest) ? ' 完成' : ' 无法测量'}` : '本时段暂无输出'}</div></div>
              <div className="metric average-metric"><h2>同配置{periodLabels[period]}均值</h2><div className="number-line"><strong className="metric-number">{formatTps(isAvailable ? scope.average : null)}</strong><span className="unit">TPS</span></div><div className="metric-caption">{scope.validCount} 次有效</div></div>
            </section>
            <div className="detail-configuration">
              <label className="detail-profile-label">输出记录的配置</label>
              <Select className="detail-profile-select" value={scope.profile?.id} placeholder="此时段暂无完成输出" size="small" aria-label="选择模型配置" options={scope.profiles.map((item) => ({ value: item.id, label: profileLabel(item), profile: item }))} disabled={!scope.profiles.length} optionRender={(option) => <div className="profile-option"><strong>{option.data.profile.model || '模型未知'}</strong><span>{effortLabel(option.data.profile)} · {speedLabel(option.data.profile)}</span></div>} onChange={(value) => { captureReadingLayout(); setSelectedProfile(value); }} open={profileOpen} onOpenChange={setProfileOpen} popupMatchSelectWidth={360} listHeight={180} getPopupContainer={() => document.body} />
              <Tooltip title={scope.profile?.actualTier || scope.profile?.requestedTier || scope.profile?.submittedTier ? requestedUnconfirmed ? scope.profile?.requestedTier ? '速度为请求档位，实际处理档位尚未确认。' : '提交设置，实际处理档位未确认。' : '已从记录识别实际处理档位。' : UNKNOWN_SPEED} placement="bottomLeft"><span className="detail-speed">实际档位：{scope.profile?.actualTier ? speedLabel({ ...scope.profile, requestedTier: null }) : '未知 · 记录未确认'} <InfoCircleOutlined /></span></Tooltip>
              {row?.currentProfile && <div className="detail-current"><span>当前观察</span><Configuration profile={row.currentProfile} /></div>}
              {row?.currentProfile && scope.profile && row.currentProfile.id !== scope.profile.id && <p className="detail-changed">配置已变，读数仍属于所选输出配置。</p>}
            </div>
          </div>
          {expanded && <Suspense fallback={<div className="plot-wrap plot-loading">正在准备曲线…</div>}><SpeedHistory key={conversation} samples={chartSamples} scopeBounds={scope.bounds} now={now} paused={!expanded || !detailsOpen} unavailable={!isAvailable} expandedView={chartOpen} onClose={() => setChartOpen(false)} profileLabel={chartProfile ? profileLabel(chartProfile) : '配置未知'} /></Suspense>}
          <dl className="configuration-evidence"><dt>提交设置</dt><dd>{scope.profile?.submittedTier ? speedLabel({ ...scope.profile, actualTier: null, requestedTier: null }) : '未知 · 记录未提供'}</dd><dt>请求档位</dt><dd>{scope.profile?.requestedTier ? speedLabel({ ...scope.profile, actualTier: null }) : '未知 · 记录未提供'}</dd><dt>实际处理</dt><dd>{scope.profile?.actualTier ? speedLabel({ ...scope.profile, requestedTier: null }) : '未知 · 记录未确认'}</dd></dl>
          <p className="detail-note">TPS 包含推理与工具调用参数，不代表屏幕文字出现速度。<br />缺少可信计时的输出留缺口，不计入均值；不合并并行对话速度。</p>
        </div>}
        </Modal>
        <footer className="overview-footer"><span className={controlError || orderWarning || monitorView.cached || !isAvailable ? 'footer-status has-error' : 'footer-status'} role={controlError || orderWarning || orderPending || monitorView.cached || !isAvailable || copiedName ? 'status' : undefined} title={orderWarning || (monitorView.cached ? snapshot.message : undefined)}>{controlError || orderWarning || (monitorView.cached || !isAvailable ? snapshot.message || '统计暂时不可用' : orderPending ? '正在保存顺序…' : copiedName ? '完整名称已复制' : groupedView ? '组内顺序固定 · 编号可调序' : snapshot.mode === 'demo' ? '示例数据 · 编号可调序' : '顺序固定 · 编号可调序')}</span><Tooltip title={`TPS 为已完成输出的估算，可能包含推理与工具调用参数，并非实时打字速度。均值只比较同一配置，不合并并行速度。${UNKNOWN_SPEED}`} placement="topLeft"><span className="measurement-hint">完成轮次 TPS <InfoCircleOutlined /></span></Tooltip></footer>
      </section>
      {controlError && !expanded && <span className="sr-only" role="status">{controlError}</span>}
    </main>
  </ConfigProvider>;
}
