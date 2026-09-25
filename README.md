# Github Private Vault Sync

Sync notes and attachments across devices using a **private GitHub repository** on your own account. 

## Features

- Connect with GitHub Device Flow (no OAuth callback server)
- Separate private repository per vault (`obsidian-<vault-name>`)
- Pull when Obsidian opens, optional auto-sync on save
- Manual sync from the status bar or command palette
- Conflict resolution UI when the same file changes on two devices

## Requirements

- Obsidian >= **1.11.4+**
- A GitHub account
- **From source:** Node.js **18+**, npm

---

## Install

1. Copy `main.js` and `manifest.json` into `path-to-your-vault/.obsidian/plugins/gh-ob-vault-sync/`
2. **Settings → Community plugins** — disable Restricted Mode if needed, enable **Github Private Vault Sync**.
3. **Settings → Github Private Vault Sync → Connect GitHub**, enter the code on [github.com/login/device](https://github.com/login/device), and authorize repository access.

Repeat on each device with the **same GitHub account**. 
The first device creates the repository and pushes. Later devices clone it.

---

## Usage

| Action | Behavior |
|--------|----------|
| Save / create / delete files | Queued for sync when Auto-sync is on |
| Open Obsidian | Pull from GitHub |
| Close Obsidian | Pending queue is flushed |
| Status bar click | Manual full sync |
| Command palette | Sync vault now |

**Conflicts:** if the same file changed locally and on GitHub, choose keep yours, keep remote, or edit manually, then sync again.

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Auto-sync | Enable to sync on file changes | Off |
| Sync debounce | Delay after last edit | 3000 ms |
| Excluded patterns | One pattern per line, `*` allowed | `.obsidian/**` |
