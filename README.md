# OctoLauncher

> **Unofficial fork** of [OctoWoW's OctoLauncher](https://octowow.st/git/octocontr/OctoLauncher), maintained by Salahaja. It is not made or supported by the OctoWoW team. What it changes is under [This fork](#this-fork-138-plus).
>
> **On Windows 7?** The official launcher can't run there. Download the `-64bit` or `-32bit` installer from [Releases](https://github.com/Salahaja/OctoLauncher-plus/releases), and see the [Windows 7 notes](https://github.com/Salahaja/OctoLauncher-plus/tree/win7#windows-7-build-branch-win7).

Desktop launcher for the OctoWoW (World of Warcraft 1.12.1 private server) client. Built with Electron, React, and tRPC.

**What it does:**
- Downloads and patches the OctoWoW game client via a manifest-based CDN updater
- Rewrites `Config.wtf` with the correct realm/patch-list on every launch
- Optionally applies binary tweaks to `WoW.exe` (FOV, far-clip, large-address flag, etc.)
- Injects client mods (VanillaFixes, DXVK, nampower, etc.) via a DLL chainloader
- Manages git-based addon installations
- Self-updates via NSIS

---

## This fork (1.3.8-plus)

Built on the official 1.3.8: the public source stops at 1.3.6, and the 1.3.7–1.3.8 changes were recovered from the shipped `app.asar`, so it behaves as the official build does. On top of that:

- **Several clients at once.** With WoW already running, Play becomes *Launch another*: it starts one more client and skips everything that would rewrite files the open clients hold. The launcher returns from the tray when the last one closes, and checks files then.
- **Tools tab.** Live player count, the realm addresses OctoWoW's DNS (37.156.68.20) gives next to what the hosts file pins, a login-port probe for each, and a plain verdict. *Pin server addresses* runs the bundled [octowow-hosts-updater](https://github.com/Salahaja/octowow-hosts-updater) script elevated; *Remove pins* takes the block out again. *Wait, then launch* polls the login port and starts the game when it answers.
- **Our addons.** Every public repo of `Salahaja` with `<repo>.toc` at its root is listed in its own section, found through the GitHub API, so new ones appear without a launcher release. A `!<repo>.toc` installs into `!<repo>` (WoW folders may start with `!` to load first; GitHub names can't). A fork is listed only when it carries commits of ours, and then replaces the original's catalog entry; a plain mirror would only shadow newer releases. pfQuest-turtle is hidden from the catalog in favour of pfQuest [Octo DB+].
- **Local work is safe.** An addon with uncommitted edits or unpushed commits shows *Local changes* and is left out of *Update all*; updating it asks first.
- **Clones made outside the launcher verify cleanly.** A fork's clone is compared with `origin`, not whichever remote git lists first (`upstream`), and a file that differs from the commit only in line endings (command-line git on Windows checks out CRLF) is not a local change.
- **No self-update to the official build**, which would undo all of this. Set `MAIN_VITE_UPDATE_FEED_URL` at build time to point self-updates at a feed of your own.

Building it is as below, plus one file the source tree doesn't carry: copy `aria2c.exe` from an installed launcher's `resources` folder into `resources/`.

---

## Quick start (players)

1. Grab `OctoLauncher.exe` (portable) or `OctoLauncher_Installer.exe` from the [Releases](../../releases) page.
2. Run it and set your WoW client directory when prompted.
3. Click **Verify** to download any missing game files, then **Play**.

No server configuration needed; the launcher connects to `octowow.st` by default.

---

## Building from source

### Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20 LTS | Node 22+ breaks `dll-inject` native bindings: use Node 20 |
| VS 2022 Build Tools | C++ workload + Win SDK | `node-gyp` v10 only detects VS2017-2022 |
| Python | 3.x | Required by `node-gyp` |

Install Node 20 with `fnm`:
```powershell
winget install Schniz.fnm
fnm install 20
fnm default 20
```

Install VS 2022 Build Tools:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools `
  --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended"
```

### Install dependencies

```powershell
npm install
```

`postinstall` rebuilds the native modules (`dll-inject`, `stormlib-node`) against the Electron ABI; expect C++ compiler output.

### Run in development

> **VSCode users:** The integrated terminal sets `ELECTRON_RUN_AS_NODE=1`, which crashes Electron. Unset it first:
> ```powershell
> Remove-Item Env:ELECTRON_RUN_AS_NODE
> ```

```powershell
npm run dev
```

Opens the app in a hot-reloading Electron window. The dev build points to `http://localhost:5000` by default; create a `.env` file from `.env.example` if you want to run against a local server, otherwise it falls back to `https://octowow.st`.

### Build for distribution

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
npm run dist
```

Outputs to `dist/`:
- `OctoLauncher.exe`: portable single-file
- `OctoLauncher_Installer.exe`: NSIS installer

The production build uses `.env.production` (committed) which points to `https://octowow.st`. No `.env` file needed.

---

## Running the dev backend

The `server/` subdirectory is a standalone Express server that simulates the production CDN for local development. It is **not** bundled into the Electron app.

```powershell
cd server
npm install
```

Create `server/.env` from `server/.env.example` and set `SOURCE_DIR` to your local WoW client directory, then:

```powershell
npm run dev
```

The server listens on `http://localhost:5000` and serves:
- `GET /api/file/:version/manifest.json`
- `GET /client/:version/*`: per-file downloads
- `GET /api/addons.json`

---

## Architecture overview

Three Vite bundles tied together by tRPC over Electron IPC:

- **Main** ([src/main/](src/main/)): Electron main process; owns all filesystem/native work and the tRPC router
- **Preload** ([src/preload/](src/preload/)): secure IPC bridge via `exposeElectronTRPC()`
- **Renderer** ([src/renderer/](src/renderer/)): React 18 + Tailwind UI; no direct Node access

All cross-process data shapes are Zod schemas in [src/common/schemas.ts](src/common/schemas.ts). All renderer→main calls go through tRPC procedures in [src/main/api/routers/](src/main/api/routers/); never raw `ipcMain.handle`.

---

## License

MIT
