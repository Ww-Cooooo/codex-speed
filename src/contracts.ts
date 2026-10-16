export interface ProfileView {
  id: string;
  model: string | null;
  effort: string | null;
  requestedTier: string | null;
  submittedTier: string | null;
  actualTier: string | null;
}
export interface SampleView {
  profileId: string;
  conversationId: string;
  tps: number | null;
  completedAt: string;
  outputTokens: number;
  durationSeconds: number;
  exclusion: string | null;
}
export interface PointView { time: string; tps: number | null; exclusion: string | null }
export type ConversationState = 'generating' | 'tool' | 'waiting' | 'idle' | 'error' | 'unknown';
export type CollectionIssue = 'catching_up' | 'limited_discovery' | 'state_unavailable' | 'logs_unavailable' | 'source_unavailable' | 'records_skipped';
export interface ConversationView {
  id: string;
  title: string | null;
  state: ConversationState;
  updatedAt: string | null;
  profileId: string | null;
  isSubagent: boolean | null;
  discovered?: boolean;
}
export interface Snapshot {
  schemaVersion: 3;
  mode: 'demo' | 'live';
  status: 'monitoring' | 'waiting' | 'unavailable' | 'error';
  message: string;
  updatedAt: string;
  activeProfile: string | null;
  profiles: ProfileView[];
  samples: SampleView[];
  conversations: ConversationView[];
  collectionIssues?: CollectionIssue[];
}
export interface DesktopState { pinned: boolean; expanded: boolean; maximized: boolean; conversationOrder: string[]; expandedSize: { width: number; height: number } }
export interface DesktopBridge {
  onSnapshot: (listener: (snapshot: Snapshot) => void) => () => void;
  getSnapshot: () => Promise<Snapshot | null>;
  getState: () => Promise<DesktopState>;
  onState: (listener: (state: DesktopState) => void) => () => void;
  setPinned: (pinned: boolean) => Promise<DesktopState>;
  setExpanded: (expanded: boolean) => Promise<DesktopState>;
  setMaximized: (maximized: boolean) => Promise<DesktopState>;
  setConversationOrder: (ids: string[]) => Promise<DesktopState>;
  resizeHeight: (height: number, finished?: boolean) => void;
  hide: () => void;
  quit: () => void;
}
declare global { interface Window { tps?: DesktopBridge } }
