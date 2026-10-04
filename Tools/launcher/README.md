# Launcher build tool

`install.ps1` downloads a portable Node.js 20 LTS into `node/` and runs the
full build pipeline (`npm install --ignore-scripts`, Electron binary install,
`electron-builder install-app-deps`, `npm run build`, `npm run pack`).

Use this instead of a global Node install to avoid the ClangCL / Node version
issues documented in the repo root `BUILD.md`.

```powershell
cd Tools\launcher
.\install.ps1
```

Output: `dist\OctoLauncher.exe` (portable) and `dist\OctoLauncher_Installer.exe` (NSIS).

The `node/` directory is gitignored; it is recreated by `install.ps1`.
