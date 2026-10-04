import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { app } from 'electron';
import Logger from 'electron-log/main';

import type { HardwareInfo } from '~common/schemas';

export const HARDWARE_SCHEMA_VERSION = 1;

export const FARCLIP_FLOOR = 777;
export const FARCLIP_CEILING = 3000;

const VIDEO_CLASS_GUID = '{4d36e968-e325-11ce-bfc1-08002be10318}';

const getVramMb = (): Promise<{
	mb: number | null;
	source: HardwareInfo['vramSource'];
}> => {
	if (os.platform() !== 'win32')
		return Promise.resolve({ mb: null, source: 'none' });

	const script = [
		'$ErrorActionPreference = "Stop"',
		`$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\${VIDEO_CLASS_GUID}'`,
		'$max = [int64]0',
		'Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {',
		'  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
		'  $v = [int64]0',
		"  if ($p.'HardwareInformation.qwMemorySize') { $v = [int64]$p.'HardwareInformation.qwMemorySize' }",
		"  elseif ($p.'HardwareInformation.MemorySize') {",
		"    $m = $p.'HardwareInformation.MemorySize'",
		'    if ($m -is [byte[]]) { $v = [int64][System.BitConverter]::ToUInt32($m, 0) } else { $v = [int64]$m }',
		'  }',
		'  if ($v -gt $max) { $max = $v }',
		'}',
		'Write-Output $max'
	].join('\n');
	const encoded = Buffer.from(script, 'utf16le').toString('base64');

	return new Promise(resolve => {
		let settled = false;
		const finish = (mb: number | null, source: HardwareInfo['vramSource']) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ mb, source });
		};

		const child = spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
			{ windowsHide: true }
		);

		const timer = setTimeout(() => {
			child.kill();
			Logger.warn('VRAM detection timed out');
			finish(null, 'none');
		}, 8000);

		let stdout = '';
		child.stdout.on('data', d => (stdout += String(d)));
		child.on('error', e => {
			Logger.warn('VRAM detection failed to launch PowerShell', e);
			finish(null, 'none');
		});
		child.on('exit', code => {
			const bytes = Number(stdout.trim());
			if (code === 0 && Number.isFinite(bytes) && bytes > 0)
				finish(Math.round(bytes / 1024 / 1024), 'registry');
			else finish(null, 'none');
		});
	});
};

const getGpuModel = async (): Promise<string> => {
	try {
		const info = (await app.getGPUInfo('complete')) as {
			auxAttributes?: { glRenderer?: string };
			gpuDevice?: { active?: boolean; vendorId?: number; deviceId?: number }[];
		};
		const renderer = info?.auxAttributes?.glRenderer?.trim();
		if (renderer) return renderer;
		const active = info?.gpuDevice?.find(d => d.active) ?? info?.gpuDevice?.[0];
		if (active) return `vendor ${active.vendorId} device ${active.deviceId}`;
	} catch (e) {
		Logger.warn('GPU info detection failed', e);
	}
	return 'unknown';
};

export const detectHardware = async (): Promise<HardwareInfo> => {
	const cpus = os.cpus();
	const [vram, gpuModel] = await Promise.all([getVramMb(), getGpuModel()]);

	const info: HardwareInfo = {
		totalRamMb: Math.round(os.totalmem() / 1024 / 1024),
		cpuCores: cpus.length,
		cpuModel: cpus[0]?.model?.trim() || 'unknown',
		gpuModel,
		vramMb: vram.mb,
		vramSource: vram.source,
		detectedAt: new Date().toISOString(),
		schemaVersion: HARDWARE_SCHEMA_VERSION
	};
	Logger.info('Detected hardware', info);
	return info;
};

// DXVK needs a working 32-bit Vulkan driver; a 64-bit-only install loads
// fine in the launcher and then crashes the 32-bit client at startup
const VULKAN_PROBE_TIMEOUT_MS = 6000;

const collectIcdPaths = (): Promise<string[]> => {
	const script = [
		"$ErrorActionPreference = 'SilentlyContinue'",
		'$paths = New-Object System.Collections.Generic.List[string]',
		`$cls = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\${VIDEO_CLASS_GUID}'`,
		'Get-ChildItem $cls | ForEach-Object {',
		'  $v = (Get-ItemProperty $_.PSPath).VulkanDriverNameWow',
		'  foreach ($p in @($v)) { if ($p) { $paths.Add([string]$p) } }',
		'}',
		"$leg = 'HKLM:\\SOFTWARE\\WOW6432Node\\Khronos\\Vulkan\\Drivers'",
		'if (Test-Path $leg) {',
		'  $k = Get-Item $leg',
		'  foreach ($n in $k.GetValueNames()) {',
		'    if ($k.GetValue($n) -eq 0) { $paths.Add([string]$n) }',
		'  }',
		'}',
		'$paths | Sort-Object -Unique | ForEach-Object { $_ }'
	].join('\n');
	const encoded = Buffer.from(script, 'utf16le').toString('base64');

	return new Promise(resolve => {
		let out = '';
		let settled = false;
		const done = (v: string[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		let child: ChildProcess | undefined;
		try {
			child = spawn(
				'powershell.exe',
				['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
				{ windowsHide: true }
			);
		} catch {
			done([]);
			return;
		}
		const timer = setTimeout(() => {
			child?.kill();
			done([]);
		}, VULKAN_PROBE_TIMEOUT_MS);
		child.stdout?.on('data', d => (out += String(d)));
		child.on('error', () => done([]));
		child.on('exit', () =>
			done(
				out
					.split(/\r?\n/)
					.map(s => s.trim())
					.filter(Boolean)
			)
		);
	});
};

const icdDllExists = (
	libPath: string,
	jsonDir: string,
	sys32: string,
	sysWow: string
) => {
	try {
		if (path.isAbsolute(libPath)) return fs.existsSync(libPath);
		if (/[\\/]/.test(libPath))
			return fs.existsSync(path.resolve(jsonDir, libPath));
		return (
			fs.existsSync(path.join(sysWow, libPath)) ||
			fs.existsSync(path.join(sys32, libPath))
		);
	} catch {
		return false;
	}
};

const detectVulkanCapable = async (): Promise<boolean> => {
	try {
		if (os.platform() !== 'win32') return false;
		const systemRoot =
			process.env.SystemRoot || process.env.windir || 'C:\\Windows';
		const sys32 = path.join(systemRoot, 'System32');
		const sysWow = path.join(systemRoot, 'SysWOW64');
		const is64 = fs.existsSync(sysWow);
		const loader = is64
			? path.join(sysWow, 'vulkan-1.dll')
			: path.join(sys32, 'vulkan-1.dll');
		if (!fs.existsSync(loader)) {
			Logger.info('[vulkan] 32-bit loader absent; DXVK default OFF');
			return false;
		}
		const candidates = await collectIcdPaths();
		for (const jsonPath of candidates) {
			if (!/\.json$/i.test(jsonPath) || !fs.existsSync(jsonPath)) continue;
			try {
				const icd = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
				const lib = icd?.ICD?.library_path;
				if (
					typeof lib === 'string' &&
					lib &&
					icdDllExists(lib, path.dirname(jsonPath), sys32, sysWow)
				) {
					Logger.info(`[vulkan] capable: verified 32-bit ICD ${jsonPath}`);
					return true;
				}
			} catch {
				// unreadable manifest, try the next one
			}
		}
		Logger.info('[vulkan] no verified 32-bit ICD; DXVK default OFF');
		return false;
	} catch (e) {
		Logger.warn('[vulkan] probe failed; defaulting DXVK OFF', e);
		return false;
	}
};

let vulkanCapablePromise: Promise<boolean> | undefined;
export const getVulkanCapable = () => {
	if (!vulkanCapablePromise) vulkanCapablePromise = detectVulkanCapable();
	return vulkanCapablePromise;
};

const clampFarClip = (n: number) =>
	Math.min(FARCLIP_CEILING, Math.max(FARCLIP_FLOOR, Math.round(n)));

export const recommendFarClip = (hw: HardwareInfo | null): number => {
	if (!hw) return clampFarClip(1000);

	const ramGb = hw.totalRamMb / 1024;
	const cores = hw.cpuCores;
	const vramTrusted = hw.vramSource !== 'none' && hw.vramMb != null;
	const vramGb = vramTrusted ? (hw.vramMb as number) / 1024 : null;

	if (ramGb < 6 || cores <= 2) return clampFarClip(FARCLIP_FLOOR);

	if (vramGb === null)
		return clampFarClip(ramGb >= 8 && cores >= 4 ? 1500 : 1000);

	if (ramGb < 8 || vramGb < 2) return clampFarClip(1000);
	if (ramGb >= 32 && vramGb >= 8 && cores >= 8) return clampFarClip(3000);
	if (ramGb >= 16 && vramGb >= 4 && cores >= 6) return clampFarClip(2200);
	if (ramGb >= 8 && vramGb >= 2 && cores >= 4) return clampFarClip(1500);
	return clampFarClip(1000);
};
