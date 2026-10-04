import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { Resolver } from 'node:dns/promises';
import { spawn } from 'node:child_process';

import { app } from 'electron';
import fs from 'fs-extra';
import fetch from 'node-fetch';
import Logger from 'electron-log/main';

import { psSingleQuote } from '~main/utils';

import Observable from './observable';
import { startGame } from './launch';

// OctoWoW's own resolver answers for the realm names even when public DNS
// doesn't, and is what the hosts updater pins from
const OCTO_DNS_SERVER = '37.156.68.20';
const REALM_HOSTS = ['play.octowow.st', 'normal.octowow.st'];
// the realmlist the launcher writes; what the client actually dials
const LOGIN_HOST = 'play.octowow.st';
const LOGIN_PORT = 3724;
const HOSTS_TAG = 'OctoWoW';
const PROBE_TIMEOUT_MS = 3000;

const hostsPath = () =>
	path.join(
		process.env.SystemRoot || 'C:\\Windows',
		'System32',
		'drivers',
		'etc',
		'hosts'
	);

const toolPath = (name: string) =>
	app.isPackaged
		? path.join(process.resourcesPath, 'tools', name)
		: path.join(app.getAppPath(), 'resources', 'tools', name);

export type AddressStatus = { ip: string; ms: number | null };

export type HostStatus = {
	name: string;
	// what OctoWoW's resolver answers right now
	dns: string[];
	// what the hosts file's OctoWoW block pins
	pinned: string[];
	// entries outside the block; Windows uses the first match, so these win
	overrides: string[];
	addresses: AddressStatus[];
};

export type ServerStatus = {
	checkedAt: string;
	online: number | null;
	dnsAnswered: boolean;
	hasBlock: boolean;
	// pinned somewhere OctoWoW's DNS no longer points
	pinsStale: boolean;
	hosts: HostStatus[];
};

export type ElevatedResult = {
	ok: boolean;
	cancelled?: boolean;
	output: string;
};

const fetchOnlineCount = async () => {
	try {
		const res = await fetch('https://octowow.st/player-census', {
			timeout: 8000
		});
		const html = await res.text();
		const m = html.match(/Players online now:\s*<b>([\d,.\s]+)<\/b>/i);
		return m ? Number(m[1].replace(/[^\d]/g, '')) : null;
	} catch (e) {
		Logger.warn('Could not read the player census', e);
		return null;
	}
};

const resolveAgainstOcto = async (name: string) => {
	const resolver = new Resolver({ timeout: 3000, tries: 2 });
	resolver.setServers([OCTO_DNS_SERVER]);
	try {
		const ips = await resolver.resolve4(name);
		return ips.sort((a, b) =>
			a.localeCompare(b, undefined, { numeric: true })
		);
	} catch (e) {
		Logger.warn(`DNS lookup of ${name} on ${OCTO_DNS_SERVER} failed`, e);
		return null;
	}
};

// a timeout rather than a refusal is what DDoS scrubbing looks like
const probe = (ip: string, port = LOGIN_PORT) =>
	new Promise<number | null>(resolve => {
		const started = Date.now();
		const socket = net.connect({ host: ip, port });
		const done = (ms: number | null) => {
			socket.destroy();
			resolve(ms);
		};
		socket.setTimeout(PROBE_TIMEOUT_MS, () => done(null));
		socket.once('connect', () => done(Date.now() - started));
		socket.once('error', () => done(null));
	});

type HostsEntries = {
	hasBlock: boolean;
	pinned: Map<string, string[]>;
	overrides: Map<string, string[]>;
};

const readHostsEntries = async (): Promise<HostsEntries> => {
	const pinned = new Map<string, string[]>();
	const overrides = new Map<string, string[]>();
	const raw = await fs.readFile(hostsPath(), 'utf8').catch(() => '');
	let inBlock = false;
	let hasBlock = false;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === `# BEGIN ${HOSTS_TAG}`) {
			inBlock = true;
			hasBlock = true;
			continue;
		}
		if (trimmed === `# END ${HOSTS_TAG}`) {
			inBlock = false;
			continue;
		}
		if (!trimmed || trimmed.startsWith('#')) continue;
		const [ip, ...names] = trimmed.split('#')[0].trim().split(/\s+/);
		for (const name of names) {
			if (!REALM_HOSTS.includes(name)) continue;
			const into = inBlock ? pinned : overrides;
			into.set(name, [...(into.get(name) ?? []), ip]);
		}
	}
	return { hasBlock, pinned, overrides };
};

export const checkServer = async (): Promise<ServerStatus> => {
	const [online, entries, ...resolved] = await Promise.all([
		fetchOnlineCount(),
		readHostsEntries(),
		...REALM_HOSTS.map(resolveAgainstOcto)
	]);

	const hosts = await Promise.all(
		REALM_HOSTS.map(async (name, i): Promise<HostStatus> => {
			const dns = resolved[i] ?? [];
			const pinned = entries.pinned.get(name) ?? [];
			const overrides = entries.overrides.get(name) ?? [];
			const ips = [...new Set([...dns, ...pinned, ...overrides])];
			const addresses = await Promise.all(
				ips.map(async ip => ({ ip, ms: await probe(ip) }))
			);
			return { name, dns, pinned, overrides, addresses };
		})
	);

	const dnsAnswered = resolved.some(r => r !== null);
	// the updater leaves dead addresses out, so a pin that is a subset of the
	// DNS answer is fine; one DNS no longer gives is not
	const pinsStale =
		dnsAnswered &&
		hosts.some(
			h =>
				h.dns.length > 0 &&
				[...h.pinned, ...h.overrides].some(ip => !h.dns.includes(ip))
		);

	return {
		checkedAt: new Date().toISOString(),
		online,
		dnsAnswered,
		hasBlock: entries.hasBlock,
		pinsStale,
		hosts
	};
};

// Runs a PowerShell snippet elevated (one UAC prompt) and hands back what it
// printed. The elevated window is hidden, so the output comes back through a
// transcript file.
const runElevated = (snippet: string): Promise<ElevatedResult> => {
	const transcript = path.join(
		os.tmpdir(),
		`octo-elevated-${process.pid}-${Date.now()}.log`
	);
	const inner = [
		`Start-Transcript -LiteralPath ${psSingleQuote(transcript)} -Force | Out-Null`,
		'$code = 0',
		'try {',
		`  ${snippet}`,
		'  if ($LASTEXITCODE) { $code = $LASTEXITCODE }',
		'} catch {',
		"  Write-Host ('ERROR: ' + $_.Exception.Message)",
		'  $code = 1',
		'} finally {',
		'  Stop-Transcript | Out-Null',
		'}',
		'exit $code'
	].join('\n');
	const encoded = Buffer.from(inner, 'utf16le').toString('base64');
	const outer =
		'try { $p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru ' +
		"-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass'," +
		`'-EncodedCommand','${encoded}'; exit $p.ExitCode } catch { exit 1223 }`;

	return new Promise(resolve => {
		const child = spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', outer],
			{ windowsHide: true }
		);
		child.on('error', e => {
			Logger.error('Failed to launch PowerShell', e);
			resolve({ ok: false, output: 'Could not run Windows PowerShell.' });
		});
		child.on('exit', async code => {
			const raw = (await fs.readFile(transcript, 'utf8').catch(() => ''))
				// the transcript starts with a BOM, which would hide the first rule
				.replace(/^\uFEFF/, '');
			await fs.remove(transcript).catch(() => undefined);
			// keep what the snippet printed, not the transcript's header/footer
			const parts = raw.split(/^\*{10,}\s*$/m);
			const output = (parts.length >= 3 ? parts[2] : raw).trim();
			if (code === 1223)
				resolve({
					ok: false,
					cancelled: true,
					output: 'The administrator prompt was cancelled.'
				});
			else resolve({ ok: code === 0, output });
		});
	});
};

export const pinHosts = async () => {
	const script = toolPath('Update-HostsFromDns.ps1');
	if (!(await fs.pathExists(script)))
		return { ok: false, output: `Missing ${script}` } as ElevatedResult;
	Logger.log('Pinning the realm addresses in the hosts file');
	// -NoElevate: it already runs elevated and must not prompt or pause
	const result = await runElevated(
		`& ${psSingleQuote(script)} -Tag ${HOSTS_TAG} -NoElevate`
	);
	Logger.log(`Hosts update ${result.ok ? 'done' : 'failed'}:\n${result.output}`);
	return result;
};

export const unpinHosts = async () => {
	Logger.log('Removing the realm pins from the hosts file');
	const snippet = [
		`$h = ${psSingleQuote(hostsPath())}`,
		'$lines = @(Get-Content -LiteralPath $h)',
		'$b = -1; $e = -1',
		'for ($i = 0; $i -lt $lines.Count; $i++) {',
		`  if ($b -lt 0 -and $lines[$i].Trim() -eq '# BEGIN ${HOSTS_TAG}') { $b = $i }`,
		`  elseif ($b -ge 0 -and $lines[$i].Trim() -eq '# END ${HOSTS_TAG}') { $e = $i; break }`,
		'}',
		"if ($b -lt 0) { Write-Host 'There is no OctoWoW block in the hosts file.'; return }",
		"if ($e -lt 0) { throw 'The OctoWoW block has no END marker. Fix the hosts file by hand.' }",
		'$keep = @()',
		'if ($b -gt 0) { $keep += $lines[0..($b - 1)] }',
		'if ($e -lt $lines.Count - 1) { $keep += $lines[($e + 1)..($lines.Count - 1)] }',
		"$backup = '{0}.bak-{1}' -f $h, (Get-Date -Format 'yyyyMMdd-HHmmss')",
		'Copy-Item -LiteralPath $h -Destination $backup -Force',
		"$text = (($keep -join \"`r`n\").TrimEnd()) + \"`r`n\"",
		'[IO.File]::WriteAllText($h, $text, (New-Object Text.UTF8Encoding($false)))',
		'& ipconfig.exe /flushdns | Out-Null',
		"Write-Host ('Removed the OctoWoW block ({0} lines). Backup: {1}' -f ($e - $b + 1), $backup)",
		"Write-Host 'DNS resolver cache flushed.'"
	].join('\n  ');
	const result = await runElevated(snippet);
	Logger.log(`Hosts unpin ${result.ok ? 'done' : 'failed'}:\n${result.output}`);
	return result;
};

export type WaitStatus =
	| { state: 'idle'; launched?: boolean; error?: string }
	| { state: 'waiting'; since: string; attempts: number };

const WAIT_INTERVAL_MS = 5000;

// polls the login server the way the client would reach it (system resolver,
// hosts file included) and starts the game the moment it answers
class ServerWaiterClass extends Observable<WaitStatus> {
	protected _value: WaitStatus = { state: 'idle' };
	#timer: NodeJS.Timeout | undefined;

	get status() {
		return this._value;
	}
	private set status(v: WaitStatus) {
		this._value = v;
		this._notifyObservers(v);
	}

	start() {
		if (this.status.state === 'waiting') return;
		Logger.log(`Waiting for ${LOGIN_HOST}:${LOGIN_PORT} to answer`);
		this.status = {
			state: 'waiting',
			since: new Date().toISOString(),
			attempts: 0
		};
		void this.#tick();
	}

	cancel() {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.status.state === 'waiting') this.status = { state: 'idle' };
	}

	async #tick() {
		const current = this.status;
		if (current.state !== 'waiting') return;
		const ms = await probe(LOGIN_HOST);
		if (this.status.state !== 'waiting') return;
		if (ms === null) {
			this.status = { ...current, attempts: current.attempts + 1 };
			this.#timer = setTimeout(() => void this.#tick(), WAIT_INTERVAL_MS);
			return;
		}
		Logger.log(`${LOGIN_HOST} answered after ${current.attempts + 1} tries`);
		const result = await startGame();
		this.status = result.ok
			? { state: 'idle', launched: true }
			: { state: 'idle', error: result.error };
	}
}

export const ServerWaiter = new ServerWaiterClass();
