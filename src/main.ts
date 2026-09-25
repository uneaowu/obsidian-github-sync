import { Plugin, Notice, TAbstractFile } from "obsidian";
import {
  PluginSettings,
  DEFAULT_SETTINGS,
  SyncStatus,
  ConflictFile,
  SyncResult,
} from "./types";
import { GitSyncSettingsTab } from "./ui/settings-tab";
import { StatusBarItem } from "./ui/status-bar";
import { ConflictModal } from "./ui/conflict-modal";
import { GitSync } from "./sync/git-sync";
import { SyncQueue } from "./sync/queue";
import { repoExists, createRepo, vaultNameToRepoName } from "./github/api";
import {
  ensureTokenSecretId,
  readGitHubToken,
  writeGitHubToken,
  eraseGitHubToken,
} from "./auth/token-store";

export default class GitSyncPlugin extends Plugin {
  settings!: PluginSettings;
  private statusBar!: StatusBarItem;
  private gitSync: GitSync | null = null;
  private syncQueue: SyncQueue | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBar = new StatusBarItem(this);
    this.statusBar.onClick(() => this.onStatusBarClick());

    this.addSettingTab(new GitSyncSettingsTab(this.app, this));

    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.triggerManualSync(),
    });

    if (this.settings.githubUsername && this.settings.repoName) {
      const token = await this.getGitHubToken();
      if (token) {
        await this.bootSyncEngine(token);
      }
    }

    if (this.settings.pendingMerge && this.gitSync) {
      this.setStatus("conflict");
      void this.reopenConflictModal();
    }

    this.app.workspace.onLayoutReady(async () => {
      if (this.gitSync && !this.settings.pendingMerge) {
        this.setStatus("pulling");
        try {
          const result = await this.gitSync.sync();
          this.handleSyncResult(result, { quiet: true });
        } catch {
          this.setStatus("error", "Sync failed on open");
        }
      }
    });

    this.registerEvent(
      this.app.workspace.on("quit", (tasks) => {
        tasks.add(async () => {
          await this.syncQueue?.flushNow();
        });
      })
    );

    const onVaultChange = (path: string) => {
      if (!this.syncQueue || !this.settings.autoSync) return;
      if (this.settings.pendingMerge) return;
      if (this.gitSync?.isApplyingRemote) return;
      if (this.isExcluded(path) || path.startsWith(".git")) return;
      this.syncQueue.requestSync();
    };

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        onVaultChange(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        onVaultChange(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        onVaultChange(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        onVaultChange(oldPath);
        onVaultChange(file.path);
      })
    );
  }

  async onunload(): Promise<void> {
    void this.syncQueue?.flushNow();
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (loaded && loaded.pendingMerge === undefined) {
      this.settings.pendingMerge = null;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async getGitHubToken(): Promise<string | null> {
    if (!this.settings.githubTokenSecretId) {
      return null;
    }
    return readGitHubToken(this.app, this.settings.githubTokenSecretId);
  }

  async saveGitHubToken(token: string): Promise<void> {
    ensureTokenSecretId(this.settings);
    await writeGitHubToken(
      this.app,
      this.settings.githubTokenSecretId,
      token
    );
    await this.saveSettings();
  }

  async disconnectGitHub(): Promise<void> {
    this.syncQueue?.dispose();
    this.syncQueue = null;
    this.gitSync = null;

    if (this.settings.githubTokenSecretId) {
      await eraseGitHubToken(
        this.app,
        this.settings.githubTokenSecretId
      );
    }
    this.settings.githubTokenSecretId = "";
    this.settings.githubUsername = "";
    this.settings.repoName = "";
    this.settings.pendingMerge = null;
    await this.saveSettings();
  }

  setStatus(status: SyncStatus, detail?: string): void {
    this.statusBar.set(status, detail);
  }

  private onStatusBarClick(): void {
    if (this.settings.pendingMerge) {
      void this.reopenConflictModal();
      return;
    }
    void this.triggerManualSync();
  }

  async initializeRepo(token: string, username: string): Promise<void> {
    this.setStatus("connecting");

    const vaultName = this.app.vault.getName();
    const repoName = vaultNameToRepoName(vaultName);
    this.settings.repoName = repoName;

    const adapter = this.app.vault.adapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    const sync = new GitSync(
      adapter,
      vaultPath,
      token,
      username,
      repoName,
      (p) => this.isExcluded(p)
    );

    const exists = await repoExists(token, username, repoName);
    const alreadyInit = await sync.isInitialized();

    if (!exists) {
      await createRepo(token, repoName, `Obsidian vault: ${vaultName}`);
      await sync.initAndPush();
      new Notice(`Created private repo: ${username}/${repoName}`);
    } else if (!alreadyInit) {
      const cloneHadCommits = await sync.clone();
      if (!cloneHadCommits) {
        await sync.initAndPush();
        new Notice(`Initialised repo: ${username}/${repoName}`);
      } else {
        new Notice(`Cloned repo: ${username}/${repoName}`);
      }
    } else {
      new Notice(`Reconnected to: ${username}/${repoName}`);
    }

    this.settings.lastSyncTime = Date.now();
    await this.saveSettings();
    await this.bootSyncEngine(token);
    this.setStatus("idle");
  }

  async bootSyncEngine(token: string): Promise<void> {
    const { githubUsername, repoName } = this.settings;
    if (!githubUsername || !repoName) return;

    this.syncQueue?.dispose();

    const adapter = this.app.vault.adapter;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vaultPath: string = (adapter as any).basePath ?? "";

    this.gitSync = new GitSync(
      adapter,
      vaultPath,
      token,
      githubUsername,
      repoName,
      (p) => this.isExcluded(p)
    );

    this.syncQueue = new SyncQueue(
      this.gitSync,
      (status, detail) => this.setStatus(status, detail),
      (result) => this.handleSyncResult(result, { quiet: true }),
      this.settings.syncIntervalMs
    );
  }

  private handleSyncResult(
    result: SyncResult,
    options?: { quiet?: boolean }
  ): void {
    if (result.pendingMerge) {
      this.settings.pendingMerge = result.pendingMerge;
      void this.saveSettings();
    }

    if (result.conflictFiles.length > 0 && result.pendingMerge) {
      this.setStatus("conflict");
      this.showConflictModal(result.conflictFiles, result.pendingMerge.theirs);
      return;
    }

    if (result.success) {
      this.settings.pendingMerge = null;
      this.settings.lastSyncTime = Date.now();
      void this.saveSettings();
      this.setStatus("idle");
      if (!options?.quiet) {
        new Notice("Vault synced successfully.");
      }
    } else if (result.error) {
      this.setStatus("error", result.error);
      if (!options?.quiet) {
        new Notice(`Sync error: ${result.error}`);
      }
    }
  }

  async triggerManualSync(): Promise<void> {
    if (!this.gitSync) {
      new Notice(
        "Git Sync: not connected. Please connect your GitHub account in settings."
      );
      return;
    }

    if (this.settings.pendingMerge) {
      await this.reopenConflictModal();
      return;
    }

    this.setStatus("pulling");
    try {
      const result = await this.gitSync.sync();
      this.handleSyncResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
      new Notice(`Sync failed: ${msg}`);
    }
  }

  private async reopenConflictModal(): Promise<void> {
    const pending = this.settings.pendingMerge;
    if (!pending || !this.gitSync) return;

    try {
      const conflicts = await this.gitSync.loadConflictFiles(pending);
      if (conflicts.length === 0) {
        this.settings.pendingMerge = null;
        await this.saveSettings();
        this.setStatus("idle");
        return;
      }
      this.showConflictModal(conflicts, pending.theirs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
    }
  }

  private showConflictModal(conflicts: ConflictFile[], theirs: string): void {
    new ConflictModal(this.app, conflicts, async (resolutions) => {
      const result = await this.gitSync!.completeMerge(resolutions, theirs);
      if (result.success) {
        this.settings.pendingMerge = null;
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        this.setStatus("idle");
        new Notice("Merge conflicts resolved.");
      } else {
        this.setStatus("error", result.error);
        new Notice(`Failed to complete merge: ${result.error}`);
      }
    }).open();
  }

  private isExcluded(filepath: string): boolean {
    return this.settings.excludePatterns.some((pattern) => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regexStr = escaped.replace(/\*/g, ".*");
      return new RegExp(`^${regexStr}$`).test(filepath);
    });
  }
}
