import { SYNC_DEBOUNCE_MS } from "../constants";
import { GitSync } from "./git-sync";
import { SyncResult, SyncStatus } from "../types";

type StatusCallback = (status: SyncStatus, detail?: string) => void;
type ResultCallback = (result: SyncResult) => void;

export class SyncQueue {
  private syncRequested = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private gitSync: GitSync;
  private onStatus: StatusCallback;
  private onResult: ResultCallback;
  private debounceMs: number;

  constructor(
    gitSync: GitSync,
    onStatus: StatusCallback,
    onResult: ResultCallback,
    debounceMs = SYNC_DEBOUNCE_MS
  ) {
    this.gitSync = gitSync;
    this.onStatus = onStatus;
    this.onResult = onResult;
    this.debounceMs = debounceMs;
  }

  /** Request a debounced sync (any vault change). */
  requestSync(): void {
    this.syncRequested = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.syncRequested = false;
  }

  /** Immediately run sync if requested (used on vault close). */
  async flushNow(): Promise<SyncResult | null> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.syncRequested = true;
    return this.flush();
  }

  private async flush(): Promise<SyncResult | null> {
    if (this.running || !this.syncRequested) return null;

    this.running = true;
    this.syncRequested = false;

    try {
      this.onStatus("pushing");
      const result = await this.gitSync.sync();
      this.onResult(result);

      if (result.conflictFiles.length > 0) {
        this.onStatus("conflict");
      } else if (result.success) {
        this.onStatus("idle");
      } else {
        this.onStatus("error", result.error);
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onStatus("error", msg);
      const result: SyncResult = { success: false, conflictFiles: [], error: msg };
      this.onResult(result);
      return result;
    } finally {
      this.running = false;
      if (this.syncRequested) {
        setTimeout(() => this.flush(), 500);
      }
    }
  }
}
