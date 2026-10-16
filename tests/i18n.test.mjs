// Localization coverage: every English key the code and content use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, and the language follows sh-language.js and
// switches live. Run: node --test tests/i18n.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { codeKeys, audit } from './i18n-common.mjs';
import { TABLES } from '../strings.js';
import * as content from '../content.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function usedKeys() {
	const keys = new Set();
	for (const f of ['ui.js', 'game.js', 'platform.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
	for (const t of content.TUTORIALS) keys.add(t.title), keys.add(t.text);
	for (const c of content.CHALLENGES) keys.add(c.name), keys.add(c.desc);
	keys.add('Stage {n}'); keys.add('Mastery {n}'); keys.add('Daily {date}');   // composed in game.js stageLabel/dailyLabel
	return [...keys].filter((k) => /[A-Za-z]/.test(k) && k !== 'Hillwheel').sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
	assert.deepEqual(audit(TABLES, usedKeys()), []);
});

test('the locale follows sh-language and switches live', async () => {
	const events = [];
	globalThis.document = { documentElement: { lang: 'en' }, querySelectorAll: () => [], dispatchEvent: (e) => events.push(e.detail.lang) };
	globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o.detail; } };
	const sandbox = { navigator: { languages: ['de-DE'], language: 'de-DE' }, localStorage: { getItem: () => null, setItem() {} }, document: globalThis.document, location: { search: '' } };
	sandbox.window = sandbox; sandbox.self = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(read('sh-language.js'), sandbox);
	globalThis.window = sandbox;
	try {
		const I18N = await import('../i18n.js?boot=' + Date.now());
		assert.equal(I18N.currentLang(), 'de-DE');
		assert.equal(globalThis.document.documentElement.lang, 'de-DE');
		assert.equal(I18N.T('Settings'), 'Einstellungen');
		const msg = I18N.L('Checkpoint {n} of {total}', { n: 2, total: 4 });
		I18N.language.setChoice('fr-CA');
		assert.equal(I18N.currentLang(), 'fr-CA');
		assert.equal(events.at(-1), 'fr-CA');
		assert.equal(msg(), 'Point de contrôle 2 sur 4');
	} finally {
		delete globalThis.window; delete globalThis.document; delete globalThis.CustomEvent;
	}
});
