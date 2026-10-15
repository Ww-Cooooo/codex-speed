import type { ConversationView, ProfileView, SampleView, Snapshot } from './contracts';

// Deliberately synthetic and opt-in. No local Codex content or titles are used.
export function createDemoSnapshot(scenario = ''): Snapshot {
  const now = Date.now();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const todaySpan = Math.max(1, now - day.getTime() - 60_000);
  const profiles: ProfileView[] = [
    { id: 'a1'.repeat(16), model: 'gpt-6.1-sol', effort: 'high', requestedTier: 'priority', submittedTier: null, actualTier: null },
    { id: 'b2'.repeat(16), model: 'gpt-6.1-sol', effort: 'xhigh', requestedTier: null, submittedTier: 'priority', actualTier: null },
    { id: 'c3'.repeat(16), model: 'gpt-6-astra', effort: 'high', requestedTier: 'priority', submittedTier: null, actualTier: 'priority' },
    { id: 'd4'.repeat(16), model: null, effort: null, requestedTier: null, submittedTier: null, actualTier: null },
  ];
  const conversationA = 'ab'.repeat(32);
  const conversationB = 'cd'.repeat(32);
  const ids = [conversationA, conversationB, ...['ef', '12', '34', '56', '78', '90'].map((value) => value.repeat(32))];
  const conversations: ConversationView[] = [
    { id: ids[0], title: '课程页面开发', state: 'generating', updatedAt: new Date(now - 2_000).toISOString(), profileId: profiles[1].id, isSubagent: false },
    { id: ids[1], title: '视频脚本与素材整理', state: 'tool', updatedAt: new Date(now - 4_000).toISOString(), profileId: profiles[0].id, isSubagent: false },
    { id: ids[2], title: '课程页面开发', state: 'waiting', updatedAt: new Date(now - 6_000).toISOString(), profileId: profiles[2].id, isSubagent: false },
    { id: ids[3], title: '为下一期讲解准备完整的事实核查和画面素材清单', state: 'generating', updatedAt: new Date(now - 8_000).toISOString(), profileId: profiles[3].id, isSubagent: false },
    { id: ids[4], title: '开源项目对比', state: 'idle', updatedAt: new Date(now - 60_000).toISOString(), profileId: profiles[0].id, isSubagent: false },
    { id: ids[5], title: '工具交互优化', state: 'idle', updatedAt: new Date(now - 80_000).toISOString(), profileId: profiles[1].id, isSubagent: true },
    { id: ids[6], title: null, state: 'unknown', updatedAt: null, profileId: null, isSubagent: null },
    { id: ids[7], title: '本地导出检查', state: 'error', updatedAt: new Date(now - 10_000).toISOString(), profileId: profiles[2].id, isSubagent: false },
  ];
  const samples: SampleView[] = [];
  const add = (profile: number, conversationId: string, time: number, tps: number | null, durationSeconds = 10) => samples.push({
    profileId: profiles[profile].id, conversationId, completedAt: new Date(time).toISOString(), tps,
    outputTokens: tps === null ? 846 : Math.round(tps * durationSeconds), durationSeconds: tps === null ? 0 : durationSeconds,
    exclusion: tps === null ? 'missing_timing' : null,
  });
  const values = [66.1, 72.5, 74.8, 70.2, 83.1, 89.4, null, 78.3, 80.7, 81.6, 76.4, 80.7, 84.6];
  values.forEach((tps, index) => add(0, index % 3 === 0 ? conversationB : conversationA, day.getTime() + todaySpan * (index + 1) / (values.length + 1), tps, index % 2 ? 20 : 5));
  add(1, conversationA, day.getTime() + todaySpan * 0.45, 57.2);
  add(2, conversationB, day.getTime() + todaySpan * 0.68, 51.8);
  add(3, conversationB, day.getTime() + todaySpan * 0.5, 61.3);
  add(2, ids[2], day.getTime() + todaySpan * 0.7, 49.6);
  add(0, ids[4], now - 60_000, 77.5);
  add(1, ids[5], now - 80_000, 58.2);
  add(3, ids[6], now - 90_000, 62.3);
  add(2, ids[7], now - 10_000, null);
  for (const days of [1, 3, 6, 15, 29]) {
    const time = new Date(day);
    time.setDate(time.getDate() - days);
    time.setHours(13, 20, 0, 0);
    add(0, conversationA, time.getTime(), 65 + days / 2);
  }
  if (scenario === 'empty') { samples.length = 0; conversations.length = 0; }
  if (scenario === 'running') samples.length = 0;
  if (scenario === 'gap') add(0, conversationA, now - 1_000, null);
  if (scenario === 'unknown') add(3, conversationB, now - 1_000, 61.3);
  samples.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  return {
    schemaVersion: 3, mode: 'demo',
    status: scenario === 'error' ? 'error' : scenario === 'unavailable' ? 'unavailable' : scenario === 'empty' ? 'waiting' : 'monitoring',
    message: scenario === 'error' ? '统计暂时不可用' : scenario === 'unavailable' ? '尚未发现可读取的 Codex 记录' : '',
    updatedAt: new Date(now).toISOString(), activeProfile: samples.at(-1)?.profileId ?? null, profiles, samples, conversations,
  };
}
