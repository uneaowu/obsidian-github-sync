export interface PendingMerge {
  /** Remote commit oid (FETCH_HEAD) being merged. */
  theirs: string;
  conflictPaths: string[];
}

export interface PluginSettings {
  /** Random per-vault id — OAuth token lives in app.secretStorage under this key. */
  githubTokenSecretId: string;
  githubUsername: string;        // Authenticated GitHub username
  repoName: string;              // e.g. "obsidian-my-vault"
  autoSync: boolean;             // auto-sync on file changes
  syncIntervalMs: number;        // debounce window
  excludePatterns: string[];     // glob patterns to ignore (e.g. ".obsidian/**")
  lastSyncTime: number;          // unix timestamp of last successful sync
  commitMessageTemplate: string; // e.g. "sync: {{datetime}}"
  /** Unfinished merge requiring user resolution (survives restart). */
  pendingMerge: PendingMerge | null;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  githubTokenSecretId: "",
  githubUsername: "",
  repoName: "",
  autoSync: false,
  syncIntervalMs: 3000,
  excludePatterns: [".obsidian/**"],
  lastSyncTime: 0,
  commitMessageTemplate: "sync: {{datetime}}",
  pendingMerge: null,
};

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string;
  email: string;
}

export interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url: string;
}

export type SyncStatus =
  | "idle"
  | "pulling"
  | "pushing"
  | "conflict"
  | "error"
  | "connecting";

export interface ConflictFile {
  path: string;
  ours: string;   // local file content
  theirs: string; // remote file content
}

export interface SyncResult {
  success: boolean;
  conflictFiles: ConflictFile[];
  error?: string;
  pendingMerge?: PendingMerge | null;
}
