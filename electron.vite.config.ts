import { resolve } from 'path';

import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

const alias = {
	'~common': resolve('src/common'),
	'~main': resolve('src/main'),
	'~renderer': resolve('src/renderer'),
	'~build': resolve('build')
};

export default defineConfig(({ mode }) => {
	if (mode === 'ptr') {
		const realm = loadEnv(mode, process.cwd(), 'MAIN_VITE_')
			.MAIN_VITE_PTR_REALMLIST;
		if (!realm || realm === 'octowow.st')
			throw new Error(
				'PTR build needs MAIN_VITE_PTR_REALMLIST set to a non-prod realm host'
			);
	}
	return {
		main: {
			resolve: { alias },
			plugins: [externalizeDepsPlugin()]
		},
		preload: {
			plugins: [externalizeDepsPlugin()]
		},
		renderer: {
			resolve: { alias },
			plugins: [react()]
		}
	};
});
