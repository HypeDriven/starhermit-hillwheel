// Localization coverage: every English key the native client and the content
// use is translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA →
// fr-FR inherit) in assets/strings.json and placeholders survive. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';
import * as content from '../content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TABLES = JSON.parse(read('assets/strings.json'));

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

