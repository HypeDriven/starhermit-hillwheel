// Localization: the engine's string tables (assets/strings.json, generated from
// the browser build's tables: English source strings as the keys, the nine
// StarHermit locales; en-GB, es-ES and fr-CA carry only their differences from
// en-US, es-419 and fr-FR) in the interface language the runtime reports (the
// player's choice in Options › Language, else the account's preferred language
// or the device's). The runtime's Options replaced the game's own Language
// setting (sh-language.js) and the DOM re-labelling of the old i18n.js: every
// string is drawn through T() each frame, so a change shows on the next frame
// without touching the run. The account lines are the engine's `starhermit.*` keys.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. Text with no entry passes through. */
export function T(key: string, vars?: Vars | null): string {
  if (strings.has(key)) return strings.t(key, vars ?? undefined);
  return key.replace(/\{(\w+)\}/g, (m, k: string) => (vars && vars[k] != null ? String(vars[k]) : m));
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** An account or leaderboard line (the engine's `starhermit.*` strings). */
export function sh(key: "signIn" | "invite" | "inviteCopied" | "inviteLink" | "signedOut" | "leaderboardPosting" | "leaderboardRank" | "leaderboardPosted" | "leaderboardNotPosted", vars?: Vars): string {
  return strings.t(`starhermit.${key}`, vars);
}
