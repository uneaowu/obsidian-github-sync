import { App, PluginSettingTab, Setting, Notice, ButtonComponent } from "obsidian";
import type GitSyncPlugin from "../main";
import { requestDeviceCode, pollForToken } from "../auth/github-device";
import { getAuthenticatedUser } from "../github/api";

export class GitSyncSettingsTab extends PluginSettingTab {
  plugin: GitSyncPlugin;

  constructor(app: App, plugin: GitSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Git Sync" });

    const settings = this.plugin.settings;

    // ── Account section ──────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "GitHub Account" });

    if (settings.githubUsername) {
      // Connected state
      new Setting(containerEl)
        .setName("Connected account")
        .setDesc(`Signed in as @${settings.githubUsername}`)
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              await this.plugin.disconnectGitHub();
              this.display();
              new Notice("Disconnected from GitHub.");
            })
        );

      new Setting(containerEl)
        .setName("Vault repo")
        .setDesc(`github.com/${settings.githubUsername}/${settings.repoName}`);
    } else {
      // Disconnected state
      new Setting(containerEl)
        .setName("Connect GitHub account")
        .setDesc(
          "Authorise Git Sync to access your private repos. Opens a browser window."
        )
        .addButton((btn) => {
          btn
            .setButtonText("Connect GitHub")
            .setCta()
            .onClick(async () => {
              await this.startDeviceFlow(btn);
            });
        });
    }

    // ── Sync options ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync Options" });

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc("Automatically sync when files are modified.")
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (val) => {
          settings.autoSync = val;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait this many milliseconds after the last edit before syncing.")
      .addSlider((slider) =>
        slider
          .setLimits(1000, 10000, 500)
          .setValue(settings.syncIntervalMs)
          .setDynamicTooltip()
          .onChange(async (val) => {
            settings.syncIntervalMs = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded patterns")
      .setDesc(
        "One pattern per line. Notes-only by default (.obsidian is excluded). Plugins and settings stay on each device.",
      )
      .addTextArea((ta) =>
        ta
          .setValue(settings.excludePatterns.join("\n"))
          .onChange(async (val) => {
            settings.excludePatterns = val
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Manual sync ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Manual Sync" });

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Immediately push all local changes and pull remote changes.")
      .addButton((btn) =>
        btn.setButtonText("Sync Now").onClick(async () => {
          await this.plugin.triggerManualSync();
        })
      );

    // ── Last sync time ────────────────────────────────────────────────────────
    if (settings.lastSyncTime > 0) {
      const lastSync = new Date(settings.lastSyncTime).toLocaleString();
      containerEl.createEl("p", {
        text: `Last synced: ${lastSync}`,
        cls: "setting-item-description",
      });
    }
  }

  private async startDeviceFlow(btn: ButtonComponent): Promise<void> {
    btn.setButtonText("Connecting…").setDisabled(true);

    try {
      const deviceFlow = await requestDeviceCode();

      // Show the user their one-time code
      const modal = this.containerEl.createDiv({ cls: "git-sync-device-modal" });
      modal.style.cssText =
        "background:var(--background-secondary);border-radius:8px;padding:16px;" +
        "margin-top:12px;text-align:center;";
      modal.createEl("p", {
        text: "Open this URL in your browser and enter the code below:",
      });
      const link = modal.createEl("a", {
        text: deviceFlow.verification_uri,
        href: deviceFlow.verification_uri,
      });
      link.style.display = "block";
      const codeEl = modal.createEl("h1", {
        text: deviceFlow.user_code,
        cls: "git-sync-user-code",
      });
      // Explicit styling so the code is visible regardless of Obsidian theme
      codeEl.style.cssText =
        "font-size:2rem;letter-spacing:0.25em;font-weight:700;" +
        "color:var(--text-normal);background:var(--background-primary);" +
        "border:2px solid var(--interactive-accent);border-radius:6px;" +
        "padding:8px 24px;display:inline-block;margin:12px auto;font-family:monospace;";
      modal.createEl("p", {
        text: "Waiting for you to approve in the browser…",
        cls: "setting-item-description",
      });

      // Restore button so the user can cancel / retry while waiting
      btn.setButtonText("Cancel").setDisabled(false);

      // Open browser automatically
      window.open(deviceFlow.verification_uri, "_blank");

      // Poll until approved
      const token = await pollForToken(
        deviceFlow.device_code,
        deviceFlow.interval,
        deviceFlow.expires_in
      );

      modal.remove();

      // Get user info
      const user = await getAuthenticatedUser(token);
      this.plugin.settings.githubUsername = user.login;

      await this.plugin.saveGitHubToken(token);
      await this.plugin.initializeRepo(token, user.login);
      new Notice(`Connected as @${user.login}. Vault syncing started!`);
      this.display();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Remove the code panel if it's still visible
      this.containerEl.querySelector(".git-sync-device-modal")?.remove();
      new Notice(`Connection failed: ${msg}`);
      btn.setButtonText("Connect GitHub").setDisabled(false);
    }
  }
}
