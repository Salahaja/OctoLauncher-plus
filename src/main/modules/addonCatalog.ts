import fetch from 'node-fetch';
import Logger from 'electron-log/main';

import { type TocData } from '~common/schemas';

export type CatalogEntry = {
	name: string;
	// the AddOns folder, when it isn't the repo's name: WoW folders may start
	// with '!' (to load first), GitHub repo names can't
	folder?: string;
	owner: string;
	branch?: string;
	ref?: string;
	git: string;
	toc?: TocData;
	description?: string;
	lastUpdated?: string;
	stars?: number;
	dependencies?: string[];
	ours?: boolean;
};

const FETCH_TIMEOUT_MS = 8000;

// superseded on OctoWoW: pfQuest-octo (in pfQuest-octo-plus) is the quest
// database for this server. Other Turtle-made addons stay listed; OctoWoW
// serves Turtle's server APIs too (it answers TWThreat's TWT_UDTSv4 request).
const HIDDEN = new Set(['pfQuest-turtle']);

// every public repo of this account with <repo>.toc (or !<repo>.toc) at its
// root is one of our addons, so a new one shows up without a launcher release.
// A fork counts only when it carries commits of ours; a plain mirror would
// just shadow the original's newer releases.
const OUR_GITHUB_USER = 'Salahaja';

// used when the GitHub API is unreachable or rate-limited (60 requests/hour
// per IP without a token)
const OUR_FALLBACK: { name: string; branch: string }[] = [
	{ name: 'Bagertz', branch: 'main' },
	{ name: 'Bagshui', branch: 'main' },
	{ name: 'FpsWatch', branch: 'main' },
	{ name: 'GimmetbarbieAddonManager', branch: 'main' },
	{ name: 'GrayfathersFrameroids', branch: 'main' },
	{ name: 'GrayfathersQuestshare', branch: 'main' },
	{ name: 'OctoMapReveal', branch: 'main' },
	{ name: 'pfQuest-octo-plus', branch: 'main' },
	{ name: 'Rested', branch: 'master' },
	{ name: 'Rollcall', branch: 'main' },
	{ name: 'VendorTruth', branch: 'main' },
	{ name: 'WhisperRelay', branch: 'master' },
	{ name: 'WiredbroLagDetector', branch: 'main' },
	{ name: 'WiredbroMarkers', branch: 'main' },
	{ name: 'Wrekkit', branch: 'main' }
];

export const readTocData = (content: string) =>
	(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
		.split('\n')
		.filter(l => l.startsWith('## '))
		.map(l => l.slice(3))
		.map(l => {
			const idx = l.indexOf(':');
			if (idx === -1) return null;
			return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as const;
		})
		.filter((e): e is readonly [string, string] => !!e)
		.reduce((acc, [key, value]) => {
			acc[key] = value;
			return acc;
		}, {} as TocData);

type GithubRepo = {
	name: string;
	default_branch: string;
	parent?: { full_name: string; default_branch: string };
	description: string | null;
	fork: boolean;
	archived: boolean;
	pushed_at: string;
	stargazers_count: number;
};

const githubApi = async <T>(endpoint: string) => {
	const res = await fetch(`https://api.github.com/${endpoint}`, {
		timeout: FETCH_TIMEOUT_MS,
		headers: {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'OctoLauncher'
		}
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status} for ${endpoint}`);
	return (await res.json()) as T;
};

// fork name -> carries commits of ours; asked once per launcher run, since
// it costs two of the 60 API requests an hour GitHub allows without a token
const forkIsOurs = new Map<string, boolean>();

const carriesOurCommits = async (r: GithubRepo) => {
	const known = forkIsOurs.get(r.name);
	if (known !== undefined) return known;
	try {
		const { parent } = await githubApi<GithubRepo>(
			`repos/${OUR_GITHUB_USER}/${r.name}`
		);
		if (!parent) return false;
		const { ahead_by } = await githubApi<{ ahead_by: number }>(
			`repos/${OUR_GITHUB_USER}/${r.name}/compare/${
				parent.full_name.split('/')[0]
			}:${parent.default_branch}...${OUR_GITHUB_USER}:${r.default_branch}`
		);
		forkIsOurs.set(r.name, ahead_by > 0);
		return ahead_by > 0;
	} catch (e) {
		Logger.warn(`Could not compare fork ${r.name} with its original`, e);
		return false;
	}
};

const listOurRepos = async () => {
	try {
		const repos = await githubApi<GithubRepo[]>(
			`users/${OUR_GITHUB_USER}/repos?per_page=100`
		);
		const live = repos.filter(r => !r.archived);
		const ours = await Promise.all(
			live.map(async r => !r.fork || (await carriesOurCommits(r)))
		);
		return live
			.filter((_, i) => ours[i])
			.map(r => ({
				name: r.name,
				branch: r.default_branch,
				description: r.description ?? undefined,
				lastUpdated: r.pushed_at,
				stars: r.stargazers_count
			}));
	} catch (e) {
		Logger.warn('Could not list our addon repos; using the built-in list', e);
		return OUR_FALLBACK;
	}
};

// the addon's .toc at the repo root, and the folder it names
const fetchToc = async (name: string, branch: string) => {
	for (const folder of [name, `!${name}`]) {
		try {
			const res = await fetch(
				`https://raw.githubusercontent.com/${OUR_GITHUB_USER}/${name}/${branch}/${encodeURIComponent(folder)}.toc`,
				{ timeout: FETCH_TIMEOUT_MS }
			);
			if (res.ok) return { folder, toc: readTocData(await res.text()) };
		} catch {
			// unreachable: try the next name, then give up
		}
	}
	return undefined;
};

export const fetchOurAddons = async (): Promise<CatalogEntry[]> => {
	const repos = await listOurRepos();
	const entries = await Promise.all(
		repos.map(async (r): Promise<CatalogEntry | undefined> => {
			const found = await fetchToc(r.name, r.branch);
			if (!found?.toc.Interface) return undefined;
			const { folder, toc } = found;
			return {
				...r,
				folder: folder === r.name ? undefined : folder,
				owner: OUR_GITHUB_USER,
				git: `https://github.com/${OUR_GITHUB_USER}/${r.name}.git`,
				toc,
				description: toc.Notes ?? ('description' in r ? r.description : undefined),
				ours: true
			};
		})
	);
	return entries.filter((e): e is CatalogEntry => !!e);
};

export const fetchOfficialAddons = async (): Promise<CatalogEntry[]> => {
	try {
		const response = await fetch(
			`${
				import.meta.env.MAIN_VITE_SERVER_URL || 'https://octowow.st'
			}/api/addons.json`,
			{ timeout: FETCH_TIMEOUT_MS }
		);
		return (await response.json()) as CatalogEntry[];
	} catch (e) {
		Logger.error('Failed to reach update server', e);
		return [];
	}
};

// the official catalog minus superseded entries, with our addons taking
// precedence when a name appears in both
export const fetchCatalog = async (): Promise<CatalogEntry[]> => {
	const [official, ours] = await Promise.all([
		fetchOfficialAddons(),
		fetchOurAddons()
	]);
	const ourNames = new Set(ours.flatMap(a => [a.name, a.folder ?? a.name]));
	return [
		...official.filter(a => !HIDDEN.has(a.name) && !ourNames.has(a.name)),
		...ours
	];
};
