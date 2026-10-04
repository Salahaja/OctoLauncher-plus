import { workerData, parentPort } from 'worker_threads';

import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'fs-extra';

const port = parentPort;
if (!port) throw new Error('IllegalState');

const { dir, url, ref } = workerData;

const tmpDir = `${dir}.tmp`;
const bakDir = `${dir}.bak`;

const run = async () => {
	await fs.remove(tmpDir);
	await git.clone({
		dir: tmpDir,
		fs,
		http,
		url,
		ref,
		singleBranch: !ref || ref === 'master' || ref === 'main',
		onProgress: (...args) => port.postMessage({ cb: 'onProgress', args })
	});

	await fs.remove(bakDir);
	const hadExisting = await fs.pathExists(dir);
	if (hadExisting) await fs.move(dir, bakDir);

	try {
		await fs.move(tmpDir, dir);
	} catch (e) {
		if (hadExisting) await fs.move(bakDir, dir).catch(() => undefined);
		throw e;
	}

	await fs.remove(bakDir).catch(() => undefined);
};

run()
	.then(() => port.postMessage(true))
	.catch(async err => {
		await fs.remove(tmpDir).catch(() => undefined);
		throw err;
	});
