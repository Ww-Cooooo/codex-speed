import type { ConversationState, ConversationView, PointView, ProfileView, SampleView, Snapshot } from './contracts';

export type Period = 'today' | '7days' | '30days';
export const periodLabels: Record<Period, string> = { today: '今天', '7days': '近 7 天', '30days': '近 30 天' };

// Use local calendar days rather than fixed 24-hour blocks (DST-safe).
export function periodBounds(period: Period, now: number): [number, number] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (period === '7days' ? 6 : period === '30days' ? 29 : 0));
  return [start.getTime(), now];
}

export const hasUnknownConfiguration = (profile?: ProfileView) => !profile?.model || !profile.effort || !(profile.actualTier || profile.requestedTier || profile.submittedTier);
export const effortLabel = (profile?: ProfileView) => profile?.effort ? `强度 ${profile.effort}` : '强度未知';
const tierNames: Record<string, string> = { default: '标准', standard: '标准', priority: 'Fast', fast: 'Fast', ultrafast: 'Ultrafast', flex: 'Flex', scale: 'Scale', auto: '自动' };
const tierName = (tier: string) => tierNames[tier] || tier;
export function speedLabel(profile?: ProfileView): string {
  if (profile?.actualTier) return `${tierName(profile.actualTier)}已确认${profile.requestedTier && tierName(profile.requestedTier) !== tierName(profile.actualTier) ? ` / ${tierName(profile.requestedTier)}请求` : ''}`;
  if (profile?.requestedTier) return `${tierName(profile.requestedTier)}请求`;
  if (profile?.submittedTier) return `${tierName(profile.submittedTier)}提交`;
  return '速度档位未知';
}
/** Keep overview cells short without treating a request as an actual tier. */
export function compactSpeed(profile?: ProfileView): { label: string; title: string; source: 'actual' | 'requested' | 'submitted' | 'unknown' } {
  const source = profile?.actualTier ? 'actual' : profile?.requestedTier ? 'requested' : profile?.submittedTier ? 'submitted' : 'unknown';
  if (source === 'unknown') return { label: '—', title: '本地记录未提供可识别档位，不代表未开启 Fast。', source };
  const tier = source === 'actual' ? profile!.actualTier! : source === 'requested' ? profile!.requestedTier! : profile!.submittedTier!;
  const evidence = [
    profile?.actualTier ? `实际处理：${tierName(profile.actualTier)}（已确认）` : '实际处理：尚未确认',
    profile?.requestedTier && `请求档位：${tierName(profile.requestedTier)}`,
    profile?.submittedTier && `提交设置：${tierName(profile.submittedTier)}`,
  ].filter(Boolean).join('；');
  return { label: `${tierName(tier)}${source === 'actual' ? '' : '?'}`, title: evidence, source };
}
export const profileLabel = (profile: ProfileView) => `${profile.model || '模型未知'} · ${effortLabel(profile)} · ${speedLabel(profile)}`;
export const conversationLabel = (id: string) => `对话 ${id.slice(-8)}`;
export const conversationStateLabels: Record<ConversationState, string> = {
  generating: '生成中', tool: '工具运行中', waiting: '等待中', idle: '已完成', error: '运行异常', unknown: '状态未知',
};
export const isRunning = (state: ConversationState) => state === 'generating' || state === 'tool' || state === 'waiting';

export function isValidSample(sample: SampleView): boolean {
  return !sample.exclusion && typeof sample.tps === 'number' && Number.isFinite(sample.tps) && sample.tps >= 0
    && Number.isFinite(sample.outputTokens) && sample.outputTokens >= 0 && Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0;
}

export function deriveScope(snapshot: Snapshot, conversationId: string | null, period: Period, now: number, selectedProfile: string | null) {
  const bounds = periodBounds(period, now);
  const inPeriod = snapshot.samples.filter((sample) => {
    const time = Date.parse(sample.completedAt);
    return Number.isFinite(time) && time >= bounds[0] && time <= bounds[1];
  }).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const conversations = new Map<string, SampleView>();
  for (const sample of inPeriod) conversations.set(sample.conversationId, sample);
  const samples = conversationId ? inPeriod.filter((sample) => sample.conversationId === conversationId) : inPeriod;
  const lastByProfile = new Map<string, SampleView>();
  for (const sample of samples) lastByProfile.set(sample.profileId, sample);
  const profiles = snapshot.profiles.filter((profile) => lastByProfile.has(profile.id)).sort((a, b) =>
    Date.parse(lastByProfile.get(b.id)!.completedAt) - Date.parse(lastByProfile.get(a.id)!.completedAt));
  // Preserve manual selection across refreshes. If temporarily absent from a
  // changed scope, show its newest profile without destroying that selection.
  const profile = profiles.find((item) => item.id === selectedProfile) ?? profiles[0];
  const grouped = profile ? samples.filter((sample) => sample.profileId === profile.id) : [];
  const valid = grouped.filter(isValidSample);
  const duration = valid.reduce((sum, sample) => sum + sample.durationSeconds, 0);
  const average = duration ? valid.reduce((sum, sample) => sum + sample.outputTokens, 0) / duration : null;
  const points: PointView[] = grouped.map((sample) => ({ time: sample.completedAt, tps: isValidSample(sample) ? sample.tps : null, exclusion: isValidSample(sample) ? null : sample.exclusion || 'invalid_measurement' }));
  return {
    bounds, profiles, profile, latest: grouped.at(-1), average, points,
    validCount: valid.length, excludedCount: grouped.length - valid.length,
    unknownCount: hasUnknownConfiguration(profile) ? grouped.length : 0,
    conversations: [...conversations.entries()].sort((a, b) => Date.parse(b[1].completedAt) - Date.parse(a[1].completedAt)),
  };
}

export interface ConversationRow extends ConversationView {
  label: string;
  currentProfile?: ProfileView;
  outputProfile?: ProfileView;
  latest?: SampleView;
  average: number | null;
  validCount: number;
  excludedCount: number;
}

/** Establish the initial rank once, then retain every known ID and append discoveries.
 * IDs come from the validated snapshot/desktop state; hidden rows keep their rank.
 */
export function mergeConversationOrder(saved: readonly string[], discovered: readonly string[]): string[] {
  const order = [...new Set(saved)];
  const known = new Set(order);
  for (const id of discovered) {
    if (!known.has(id)) {
      known.add(id);
      order.push(id);
    }
  }
  return saved.length ? order : order.sort((a, b) => a.localeCompare(b));
}

/** State, source order and timestamps never outrank the saved global position. */
export function orderConversationRows(rows: readonly ConversationRow[], order: readonly string[]): ConversationRow[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => {
    const left = rank.get(a.id), right = rank.get(b.id);
    if (left !== undefined && right !== undefined) return left - right;
    if (left !== undefined) return -1;
    if (right !== undefined) return 1;
    return a.id.localeCompare(b.id);
  });
}

/** Commit one drop/keyboard move; hover and cancelled drags do not change rank. */
export function moveConversation(order: readonly string[], source: string, target: string | null, placement: 'before' | 'after'): string[] {
  const next = [...order];
  if (target === null || source === target || !next.includes(source) || !next.includes(target)) return next;
  next.splice(next.indexOf(source), 1);
  next.splice(next.indexOf(target) + (placement === 'after' ? 1 : 0), 0, source);
  return next;
}

/** Optional state sections use the same global rank, never a second group sort. */
export function splitConversationRows(rows: readonly ConversationRow[], order?: readonly string[]) {
  const grouped: { running: ConversationRow[]; idle: ConversationRow[]; unknown: ConversationRow[] } = { running: [], idle: [], unknown: [] };
  for (const row of order ? orderConversationRows(rows, order) : rows) {
    if (isRunning(row.state)) grouped.running.push(row);
    else if (row.state === 'unknown') grouped.unknown.push(row);
    else grouped.idle.push(row);
  }
  return grouped;
}

/** Keep running conversations visible even when the selected period has no samples.
 * Each average belongs to the latest output's own configuration, never to all
 * configurations or to the conversation's newly selected model.
 * Keep a selected source-backed row visible across period changes; its statistics
 * still obey that period, and explicit subagent hiding still takes precedence.
 */
export function deriveOverview(snapshot: Snapshot, period: Period, now: number, showSubagents = false, retainedConversationId: string | null = null): ConversationRow[] {
  const bounds = periodBounds(period, now);
  const profiles = new Map(snapshot.profiles.map((profile) => [profile.id, profile]));
  const conversations = new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation]));
  const latest = new Map<string, SampleView>();
  const groups = new Map<string, { tokens: number; seconds: number; valid: number; excluded: number }>();
  const periodConversations = new Set<string>();
  for (const sample of snapshot.samples) {
    const time = Date.parse(sample.completedAt);
    if (!Number.isFinite(time) || time > now) continue;
    if (!conversations.has(sample.conversationId)) conversations.set(sample.conversationId, {
      id: sample.conversationId, title: null, state: 'unknown', updatedAt: null, profileId: null, isSubagent: null,
    });
    const previous = latest.get(sample.conversationId);
    if (!previous || Date.parse(previous.completedAt) <= time) latest.set(sample.conversationId, sample);
    if (time < bounds[0]) continue;
    periodConversations.add(sample.conversationId);
    const key = `${sample.conversationId}:${sample.profileId}`;
    const group = groups.get(key) ?? { tokens: 0, seconds: 0, valid: 0, excluded: 0 };
    if (isValidSample(sample)) {
      group.tokens += sample.outputTokens;
      group.seconds += sample.durationSeconds;
      group.valid += 1;
    } else group.excluded += 1;
    groups.set(key, group);
  }
  // Hide only positively identified internal agents. Unknown origins remain
  // visible, and a running conversation does not need a completed sample.
  const visible = [...conversations.values()].filter((conversation) =>
    (showSubagents || conversation.isSubagent !== true)
    && (conversation.id === retainedConversationId || conversation.updatedAt !== null || isRunning(conversation.state) || periodConversations.has(conversation.id)));
  const titleCounts = new Map<string, number>();
  for (const conversation of visible) {
    const title = conversation.title?.trim();
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const priority: Record<ConversationState, number> = { generating: 0, tool: 1, waiting: 2, error: 3, unknown: 4, idle: 5 };
  return visible.map((conversation): ConversationRow => {
    const output = latest.get(conversation.id);
    const group = output ? groups.get(`${conversation.id}:${output.profileId}`) : undefined;
    const title = conversation.title?.trim();
    const label = title ? `${title}${(titleCounts.get(title) ?? 0) > 1 ? ` · ${conversation.id.slice(-6)}` : ''}` : conversationLabel(conversation.id);
    return {
      ...conversation, label, latest: output,
      currentProfile: conversation.profileId ? profiles.get(conversation.profileId) : undefined,
      outputProfile: output ? profiles.get(output.profileId) : undefined,
      average: group?.seconds ? group.tokens / group.seconds : null,
      validCount: group?.valid ?? 0, excludedCount: group?.excluded ?? 0,
    };
  }).sort((a, b) => {
    const state = priority[a.state] - priority[b.state];
    if (state) return state;
    const time = (row: ConversationRow) => Math.max(Date.parse(row.updatedAt ?? '') || 0, Date.parse(row.latest?.completedAt ?? '') || 0);
    return time(b) - time(a) || a.id.localeCompare(b.id);
  });
}
