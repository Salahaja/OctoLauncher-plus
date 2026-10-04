
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILL = 0x78;

function pathVariants(p) {
	const set = new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')]);
	return [...set].filter(Boolean);
}

const root = process.cwd();
const home = os.homedir();
let username = '';
try {
	username = os.userInfo().username;
} catch {
	username = '';
}

const secrets = [];
if (root.length > 2) secrets.push(...pathVariants(root));
if (home.length > 2 && home !== root) secrets.push(...pathVariants(home));
if (username.length >= 4) secrets.push(username);

const needles = [...new Set(secrets)]
	.filter(s => s.length > 0)
	.map(s => s.toLowerCase())
	.sort((a, b) => b.length - a.length);

function scanAndFill(buf, s, stride) {
	const n = s.length;
	const span = n * stride;
	if (span === 0 || span > buf.length) return 0;
	let hits = 0;
	outer: for (let i = 0; i + span <= buf.length; i++) {
		for (let j = 0; j < n; j++) {
			const at = i + j * stride;
			let b = buf[at];
			if (b >= 0x41 && b <= 0x5a) b += 0x20;
			if (b !== s.charCodeAt(j)) continue outer;
			if (stride === 2 && buf[at + 1] !== 0x00) continue outer;
		}
		buf.fill(FILL, i, i + span);
		hits++;
		i += span - 1;
	}
	return hits;
}

function redact(buf) {
	let hits = 0;
	for (const s of needles) {
		hits += scanAndFill(buf, s, 1);
		hits += scanAndFill(buf, s, 2);
	}
	return hits;
}

function collect(dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) collect(p, out);
		else if (e.isFile() && p.endsWith('.node')) out.push(p);
	}
}

const addons = [];
collect(path.join(root, 'node_modules'), addons);

let files = 0;
let total = 0;
const redacted = [];
for (const file of addons) {
	try {
		const buf = fs.readFileSync(file);
		const hits = redact(buf);
		if (hits > 0) {
			fs.writeFileSync(file, buf);
			files++;
			total += hits;
			redacted.push(`${path.relative(root, file)} (${hits})`);
		}
	} catch (err) {
		console.warn(`scrub-native-paths: skipped ${path.basename(file)} (${err.message})`);
	}
}

console.log(`scrub-native-paths: redacted ${total} path reference(s) across ${files} addon(s)`);
for (const r of redacted) console.log(`  ${r}`);
