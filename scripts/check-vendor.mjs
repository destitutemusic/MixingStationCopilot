#!/usr/bin/env node
/**
 * Fail the build if the vendored MsMcp runtime drifts from the published one.
 *
 * Checks:
 *  1. the vendor directory contains exactly the files listed in VENDOR.json;
 *  2. every file matches its recorded SHA-256;
 *  3. mixingstation.js still declares DEFAULT_PORT = 8080;
 *  4. when MSMCP_DIR points at a built MsMcp checkout, each vendored file is
 *     byte-for-byte identical to dist/src/<name>.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = 'vendor/msmcp';
const manifest = JSON.parse(readFileSync(path.join(dir, 'VENDOR.json'), 'utf8'));
const problems = [];

const jsFiles = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
const listed = Object.keys(manifest.files).sort();
if (JSON.stringify(jsFiles) !== JSON.stringify(listed)) {
	problems.push(`vendor .js files ${JSON.stringify(jsFiles)} do not match the manifest ${JSON.stringify(listed)}`);
}
for (const [name, want] of Object.entries(manifest.files)) {
	const got = createHash('sha256').update(readFileSync(path.join(dir, name))).digest('hex');
	if (got !== want) problems.push(`${name}: sha256 ${got} != manifest ${want}`);
}

const mixing = readFileSync(path.join(dir, 'mixingstation.js'), 'utf8');
const port = mixing.match(/export const DEFAULT_PORT = (\d+)/);
if (!port || port[1] !== '8080') {
	problems.push(`mixingstation.js DEFAULT_PORT is ${port ? port[1] : 'missing'}, expected 8080`);
}

if (process.env.MSMCP_DIR) {
	const built = path.join(process.env.MSMCP_DIR, 'dist/src');
	for (const name of listed) {
		try {
			const upstream = readFileSync(path.join(built, name));
			if (!upstream.equals(readFileSync(path.join(dir, name)))) {
				problems.push(`${name}: differs from ${path.join(built, name)}`);
			}
		} catch (error) {
			problems.push(`${name}: cannot compare with ${built}: ${error.message}`);
		}
	}
}

if (problems.length) {
	console.error('vendor check FAILED:');
	for (const problem of problems) console.error(` - ${problem}`);
	process.exit(1);
}
console.log(`vendor check ok: ${listed.length} files, DEFAULT_PORT 8080, source ${manifest.commit.slice(0, 7)}`);
