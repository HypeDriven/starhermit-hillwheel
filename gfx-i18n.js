// Strings for the Graphics settings section, in every supported locale.
// The rest of the game is English-only (spec §10); this catalogue covers the Graphics panel.

const EN_US = {
	graphics: 'Graphics',
	quality: 'Quality',
	auto: 'Auto (detected: {tier})',
	renderScale: 'Render scale',
	fromPreset: 'From preset ({tier})',
	adaptive: 'Adaptive resolution',
	showFps: 'Show frame rate',
	postUnavailable: 'Post-processing is unavailable on this device, so effects are drawn without it.',
	unknownGpu: 'unknown GPU',
	cat: {
		shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
		antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Dust and sparkles',
		foliage: 'Trees and rocks', background: 'Sky', detail: 'Terrain detail',
	},
	tier: {
		low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', medium: 'Medium',
		off: 'Off', on: 'On', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', some: 'Some', full: 'Full',
		static: 'Still', animated: 'Animated', plain: 'Plain', detailed: 'Detailed',
	},
	words: {
		noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
		bloom: 'bloom', noAa: 'no anti-aliasing', px: '{w}×{h} px',
	},
};

const EN_GB = {
	...EN_US,
	cat: { ...EN_US.cat, grade: 'Colour grade' },
};

const ES = {
	graphics: 'Gráficos',
	quality: 'Calidad',
	auto: 'Automática (detectada: {tier})',
	renderScale: 'Escala de renderizado',
	fromPreset: 'Según el ajuste ({tier})',
	adaptive: 'Resolución adaptativa',
	showFps: 'Mostrar fotogramas por segundo',
	postUnavailable: 'El posprocesado no está disponible en este dispositivo; los efectos se dibujan sin él.',
	unknownGpu: 'GPU desconocida',
	cat: {
		shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
		antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Polvo y destellos',
		foliage: 'Árboles y rocas', background: 'Cielo', detail: 'Detalle del terreno',
	},
	tier: {
		low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Media',
		off: 'No', on: 'Sí', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', some: 'Algunos', full: 'Todos',
		static: 'Quieto', animated: 'Animado', plain: 'Simple', detailed: 'Detallado',
	},
	words: {
		noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
		bloom: 'resplandor', noAa: 'sin antialiasing', px: '{w}×{h} px',
	},
};

const ES_419 = {
	...ES,
	renderScale: 'Escala de renderizado',
	showFps: 'Mostrar cuadros por segundo',
};

const DE = {
	graphics: 'Grafik',
	quality: 'Qualität',
	auto: 'Automatisch (erkannt: {tier})',
	renderScale: 'Renderskalierung',
	fromPreset: 'Laut Voreinstellung ({tier})',
	adaptive: 'Adaptive Auflösung',
	showFps: 'Bildrate anzeigen',
	postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; Effekte werden ohne sie gezeichnet.',
	unknownGpu: 'unbekannte GPU',
	cat: {
		shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchten', grade: 'Farbkorrektur',
		antialias: 'Kantenglättung', reflections: 'Spiegelungen', particles: 'Staub und Funken',
		foliage: 'Bäume und Felsen', background: 'Himmel', detail: 'Geländedetails',
	},
	tier: {
		low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', medium: 'Mittel',
		off: 'Aus', on: 'An', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', some: 'Einige', full: 'Alle',
		static: 'Ruhig', animated: 'Animiert', plain: 'Einfach', detailed: 'Detailliert',
	},
	words: {
		noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
		bloom: 'Leuchten', noAa: 'keine Kantenglättung', px: '{w}×{h} px',
	},
};

const FR = {
	graphics: 'Graphismes',
	quality: 'Qualité',
	auto: 'Automatique (détecté : {tier})',
	renderScale: 'Échelle de rendu',
	fromPreset: 'Selon le préréglage ({tier})',
	adaptive: 'Résolution adaptative',
	showFps: 'Afficher les images par seconde',
	postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; les effets sont affichés sans lui.',
	unknownGpu: 'GPU inconnu',
	cat: {
		shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
		antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Poussière et étincelles',
		foliage: 'Arbres et rochers', background: 'Ciel', detail: 'Détail du terrain',
	},
	tier: {
		low: 'Faible', balanced: 'Équilibrée', high: 'Élevée', ultra: 'Ultra', medium: 'Moyenne',
		off: 'Non', on: 'Oui', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', some: 'Quelques-uns', full: 'Tous',
		static: 'Immobile', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
	},
	words: {
		noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
		bloom: 'halo', noAa: 'sans anticrénelage', px: '{w}×{h} px',
	},
};

const FR_CA = {
	...FR,
	showFps: 'Afficher la fréquence d’images',
	cat: { ...FR.cat, antialias: 'Antialiasing' },
	words: { ...FR.words, noAa: 'sans antialiasing' },
};

const PT_BR = {
	graphics: 'Gráficos',
	quality: 'Qualidade',
	auto: 'Automática (detectada: {tier})',
	renderScale: 'Escala de renderização',
	fromPreset: 'Conforme a predefinição ({tier})',
	adaptive: 'Resolução adaptativa',
	showFps: 'Mostrar quadros por segundo',
	postUnavailable: 'O pós-processamento não está disponível neste dispositivo; os efeitos são desenhados sem ele.',
	unknownGpu: 'GPU desconhecida',
	cat: {
		shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor',
		antialias: 'Antisserrilhamento', reflections: 'Reflexos', particles: 'Poeira e faíscas',
		foliage: 'Árvores e pedras', background: 'Céu', detail: 'Detalhe do terreno',
	},
	tier: {
		low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Média',
		off: 'Não', on: 'Sim', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', some: 'Alguns', full: 'Todos',
		static: 'Parado', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado',
	},
	words: {
		noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa',
		bloom: 'brilho', noAa: 'sem antisserrilhamento', px: '{w}×{h} px',
	},
};

const IT = {
	graphics: 'Grafica',
	quality: 'Qualità',
	auto: 'Automatica (rilevata: {tier})',
	renderScale: 'Scala di rendering',
	fromPreset: 'Dal preset ({tier})',
	adaptive: 'Risoluzione adattiva',
	showFps: 'Mostra fotogrammi al secondo',
	postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti vengono disegnati senza.',
	unknownGpu: 'GPU sconosciuta',
	cat: {
		shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
		antialias: 'Antialiasing', reflections: 'Riflessi', particles: 'Polvere e scintille',
		foliage: 'Alberi e rocce', background: 'Cielo', detail: 'Dettaglio del terreno',
	},
	tier: {
		low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', medium: 'Media',
		off: 'No', on: 'Sì', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', some: 'Alcuni', full: 'Tutti',
		static: 'Fermo', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato',
	},
	words: {
		noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
		bloom: 'bagliore', noAa: 'senza antialiasing', px: '{w}×{h} px',
	},
};

export const GFX_LOCALES = {
	'en-US': EN_US, 'en-GB': EN_GB, 'es-419': ES_419, 'es-ES': ES, 'de-DE': DE,
	'fr-FR': FR, 'fr-CA': FR_CA, 'pt-BR': PT_BR, 'it-IT': IT,
};

// Language-only fallbacks (e.g. "es-MX" → es-419, "fr-BE" → fr-FR, "pt-PT" → pt-BR).
const BY_LANG = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };
const REGION = { 'en-AU': 'en-GB', 'en-IE': 'en-GB', 'en-NZ': 'en-GB', 'es-ES': 'es-ES', 'fr-CA': 'fr-CA' };

/** Pick a supported locale from a list of BCP 47 tags (navigator.languages order). */
export function pickLocale(tags) {
	for (const raw of tags || []) {
		const tag = String(raw || '');
		if (GFX_LOCALES[tag]) return tag;
		if (REGION[tag]) return REGION[tag];
		const lang = tag.split('-')[0].toLowerCase();
		if (BY_LANG[lang]) return BY_LANG[lang];
	}
	return 'en-US';
}

export function gfxStrings(tags) {
	const list = tags || (typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : []);
	return GFX_LOCALES[pickLocale(list)];
}
