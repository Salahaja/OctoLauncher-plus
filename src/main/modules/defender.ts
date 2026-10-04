import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';
import Logger from 'electron-log/main';

import Preferences from './preferences';

export type ExclusionResult = { ok: boolean; error?: string; paths?: string[] };

const psSingleQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const addDefenderExclusions = async (): Promise<ExclusionResult> => {
	if (os.platform() !== 'win32')
		return {
			ok: false,
			error: 'Antivirus exclusions are only needed on Windows.'
		};

	const clientDir = Preferences.data.clientDir;
	if (!clientDir)
		return {
			ok: false,
			error: 'Set your game folder first, then add the exclusion.'
		};

	const launcherDir =
		process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(app.getPath('exe'));
	const paths = [...new Set([clientDir, launcherDir])];

	const resultFile = path.join(
		os.tmpdir(),
		`octo-defender-${process.pid}-${Date.now()}.txt`
	);
	const write = (v: string) =>
		`Set-Content -LiteralPath ${psSingleQuote(
			resultFile
		)} -Value "${v}" -Encoding ASCII`;

	const inner = [
		'try {',
		...paths.map(
			p =>
				`  Add-MpPreference -ExclusionPath ${psSingleQuote(
					p
				)} -ErrorAction Stop`
		),
		'  Add-MpPreference -ExclusionProcess "WoW.exe" -ErrorAction Stop',
		'  Add-MpPreference -ExclusionProcess "VanillaFixes.exe" -ErrorAction Stop',
		`  ${write('OK')}`,
		'} catch {',
		'  $t = $false',
		'  try { $t = (Get-MpComputerStatus).IsTamperProtected } catch {}',
		`  if ($t) { ${write('TAMPER')} } else { ${write('FAIL')} }`,
		'}'
	].join('\n');
	const encoded = Buffer.from(inner, 'utf16le').toString('base64');

	const outer =
		'try { Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait ' +
		"-ArgumentList '-NoProfile','-NonInteractive'," +
		`'-EncodedCommand','${encoded}' } catch { exit 1 }`;

	return new Promise<ExclusionResult>(resolve => {
		const child = spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', outer],
			{ windowsHide: true }
		);
		let stderr = '';
		child.stderr.on('data', d => (stderr += String(d)));
		child.on('error', e => {
			Logger.error('Failed to launch PowerShell for Defender exclusion', e);
			resolve({ ok: false, error: 'Could not run Windows PowerShell.' });
		});
		child.on('exit', code => {
			let result: string | null = null;
			try {
				result = fs.readFileSync(resultFile, 'utf8').trim();
			} catch {}
			try {
				fs.rmSync(resultFile, { force: true });
			} catch {}

			if (result === 'OK') {
				Logger.info(`Added Defender exclusions: ${paths.join(', ')}`);
				resolve({ ok: true, paths });
				return;
			}
			if (result === 'TAMPER') {
				Logger.error('Defender exclusion blocked by Tamper Protection');
				resolve({
					ok: false,
					error:
						'Windows Security Tamper Protection is blocking this. Turn it off in Windows Security, or add your game folder by hand under Exclusions.'
				});
				return;
			}
			if (result === 'FAIL') {
				Logger.error(`Defender exclusion failed: ${stderr}`.trim());
				resolve({
					ok: false,
					error:
						'Windows would not add the exclusion. You can add your game folder by hand in Windows Security, under Exclusions.'
				});
				return;
			}
			Logger.warn(
				`Defender exclusion: no result (exit ${code}) ${stderr}`.trim()
			);
			resolve({
				ok: false,
				error:
					'Windows did not grant permission. Click Yes on the User Account Control prompt to add the exclusion.'
			});
		});
	});
};

const SENSITIVE_FILES = [
	'WoW.exe',
	'VanillaFixes.exe',
	'd3d9.dll',
	'UnitXP_SP3.dll',
	'nampower.dll',
	'VfPatcher.dll',
	'VanillaHelpers.dll',
	'VanillaMultiMonitorFix.dll',
	'transmogfix.dll'
];

export const detectAntivirusBlocks = async (): Promise<string[]> => {
	if (os.platform() !== 'win32') return [];

	const clientDir = Preferences.data.clientDir;
	const launcherDir =
		process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(app.getPath('exe'));
	const roots = [clientDir, launcherDir]
		.filter((p): p is string => !!p)
		.map(p => p.toLowerCase());
	if (!roots.length) return [];

	const blocked = new Set<string>();

	if (clientDir && Preferences.data.syncedTorrentHash)
		for (const name of SENSITIVE_FILES) {
			// d3d9.dll is deliberately parked while dxvk is off, not blocked
			if (
				name === 'd3d9.dll' &&
				Preferences.data.mods?.dxvk?.enabled === false
			)
				continue;
			if (!fs.existsSync(path.join(clientDir, name))) blocked.add(name);
		}

	const script =
		'Get-MpThreatDetection | Where-Object ' +
		'{ $_.InitialDetectionTime -gt (Get-Date).AddHours(-12) } | ' +
		'Select-Object -ExpandProperty Resources';
	await new Promise<void>(resolve => {
		const child = spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ windowsHide: true }
		);
		let out = '';
		let settled = false;
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
		}, 15_000);
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		child.stdout.on('data', d => (out += String(d)));
		child.on('error', finish);
		child.on('exit', () => {
			for (const line of out.split(/\r?\n/)) {
				const m = /^file:_?(.+)$/.exec(line.trim());
				if (!m) continue;
				const full = m[1];
				if (
					roots.some(r => full.toLowerCase().startsWith(r)) &&
					!fs.existsSync(full)
				)
					blocked.add(path.basename(full));
			}
			finish();
		});
	});

	return [...blocked];
};
