# OctoLauncher Build Guide (Windows)

End-to-end setup that gets `npm run dev` and `npm run dist` working on a fresh Windows machine. Captured from a working build on Windows 10 / April 2026.

## Changes made to the dev environment

The project as checked out does **not** build on a default up-to-date Windows dev machine. These are the deltas applied to get it working, in order:

1. **Added a Node version manager (`fnm`) and installed Node 20** alongside the existing Node 24. Node 24 was the system default and caused `nan` / `dll-inject` compile failures. Node 20 is now the fnm default but Node 24 is still available via `fnm use system`.
2. **Installed Visual Studio 2022 Build Tools** with the `VCTools` workload and Windows 11 SDK. Machine already had VS2026 (v18), but `node-gyp` v10 (shipped with Node 20's npm) doesn't detect it. VS2022 now lives side-by-side under `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`.
3. **Unset `ELECTRON_RUN_AS_NODE`** per-shell before launching Electron. This var is set globally by VSCode's integrated terminal (inherited from the extension host): it is not something we can remove permanently without breaking VSCode. It has to be unset in each shell that runs `npm run dev` / `dist`.
4. **Populated `node_modules`** in both `main/` and `main/server/`. The tree was checked in empty.

Nothing in the repo itself was modified; all fixes were environmental. If another developer checks this repo out, they need to apply items 1-4 on their own machine. The sections below are that recipe.

---

## Prerequisites

### 1. Node.js 20 (not 22, not 24)

Node 24 breaks the `dll-inject` native module; its `nan` C++ bindings don't compile against V8 in Node 22+. Stick to Node 20 LTS.

Install via `fnm` so you can keep your system Node separate:

```bash
winget install Schniz.fnm --accept-source-agreements --accept-package-agreements
fnm install 20
fnm default 20
```

Verify: `node -v` should print `v20.x.x`.

### 2. Visual Studio 2022 Build Tools (C++ workload)

`dll-inject` and `stormlib-node` compile native addons via `node-gyp`. `node-gyp` v10 (bundled with Node 20's npm) only recognizes VS2017-2022; newer VS versions (2026 / v18) are not detected.

```bash
winget install Microsoft.VisualStudio.2022.BuildTools \
  --accept-source-agreements --accept-package-agreements \
  --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22621 --includeRecommended"
```

~6 GB download, requires admin. Even if you already have VS2026, you need VS2022 side-by-side for node-gyp.

### 3. Python 3 (usually already present)

`node-gyp` needs Python on PATH. Any 3.x works.

## Install dependencies

From the repo root:

```bash
npm install --ignore-scripts
node node_modules/electron/install.js
node_modules/.bin/electron-builder.cmd install-app-deps
```

Why the three-step approach: `dll-inject` requires ClangCL if compiled against the system Node, but compiles fine against Electron's bundled V8 headers (which `electron-builder install-app-deps` uses). Running plain `npm install` fails if your VS2022 installation doesn't include the LLVM/ClangCL component; `--ignore-scripts` skips that step and lets `install-app-deps` handle it correctly.

Or, use the provided build script which downloads a portable Node 20 and handles everything automatically:

```powershell
.\Tools\launcher\install.ps1
```

Then the server (only needed if running a local CDN, see `server/.env.example`):

```bash
cd server
npm install
cd ..
```

## Critical env var: `ELECTRON_RUN_AS_NODE`

**VSCode's integrated terminal sets `ELECTRON_RUN_AS_NODE=1`** (inherited from VSCode's extension host). This makes Electron binaries launch as plain Node, so `require('electron')` returns a path string instead of the API: the app crashes with `TypeError: Cannot read properties of undefined (reading 'isPackaged')`.

Before any `npm run dev` / `npm run build` / `npm run dist`:

```bash
unset ELECTRON_RUN_AS_NODE 
```

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

An external terminal (Windows Terminal, cmd, plain PowerShell) doesn't have this problem; the variable is only set inside VSCode.

## Running in dev

```bash
npm run dev
```

Starts electron-vite, builds main + preload + renderer, opens an Electron window on `http://localhost:5173` (or `5174` if 5173 is taken). Closing the window ends the session.

You'll see benign warnings in the console:

- `ERROR:cache_util_win.cc ... Access is denied`: OneDrive sync locking Electron's user-data cache. Cosmetic. To silence, move the project out of OneDrive or set a custom user-data dir.
- `Browserslist: caniuse-lite is outdated`: cosmetic.

## Building for distribution

The `dist` script runs `tsc && npm run build && npm run pack`:

```bash
unset ELECTRON_RUN_AS_NODE
npm run dist
```

Outputs land in `dist/`:

- `OctoLauncher.exe`: portable single-file build
- `OctoLauncher_Installer.exe`: NSIS installer

Targets are configured in [electron-builder.yml](electron-builder.yml).

### Before publishing

- The build uses `.env.production` (committed) which already points to `https://octowow.st`: no `.env` file needed for production builds.
- Code signing is not configured. Unsigned Windows builds trigger SmartScreen warnings. To sign, add a `win.certificateFile` + password (or use env-based signing) to the electron-builder config.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `nan_scriptorigin.h ... cannot convert 'v8::Isolate *'` during `npm install` | Node 22+ breaks `nan` | Switch to Node 20 |
| `gyp ERR! find VS Could not find any Visual Studio installation` | Only VS2023+ installed | Install VS2022 Build Tools |
| `error MSB8020: The build tools for ClangCL cannot be found` | Missing LLVM component during plain `npm install` | Use `npm install --ignore-scripts` + `electron-builder install-app-deps` (see above) |
| `TypeError: Cannot read properties of undefined (reading 'isPackaged')` at launch | `ELECTRON_RUN_AS_NODE=1` set by VSCode | `unset ELECTRON_RUN_AS_NODE` |
| `Port 5173 is in use` | Prior dev server didn't exit cleanly | Ignore (vite falls back to 5174) or kill the stale process |
