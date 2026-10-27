// Localization coverage: every English key the native client and the content
// use is translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA →
// fr-FR inherit), placeholders survive, and the account strings are complete
// in all nine locales. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit, LOCALES } from './i18n-common.mjs';
import { TABLES } from '../strings.js';
import { SH_ALL } from '../account-strings.js';
import * as content from '../content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

export function usedKeys() {
	const keys = new Set();
	for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) codeKeys(read(`native/${f}`), [], ['T', 'N']).forEach((k) => keys.add(k));
	for (const t of content.TUTORIALS) keys.add(t.title), keys.add(t.text);
	for (const c of content.CHALLENGES) keys.add(c.name), keys.add(c.desc);
	keys.add('Stage {n}'); keys.add('Mastery {n}'); keys.add('Daily {date}');   // composed in main.ts stageLabel/dailyLabel
	return [...keys].filter((k) => /[A-Za-z]/.test(k) && k !== 'Hillwheel').sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
	assert.deepEqual(audit(TABLES, usedKeys()), []);
});

test('account strings exist in all nine locales with the same keys', () => {
	const keys = Object.keys(SH_ALL['en-US']).sort();
	for (const l of LOCALES) assert.deepEqual(Object.keys(SH_ALL[l] ?? {}).sort(), keys, l);
	for (const l of LOCALES) assert.ok(SH_ALL[l].lbRank.includes('{rank}') && SH_ALL[l].copyFailed.includes('{link}'), l);
});
