// The look of the menus, HUD and dialogs: the browser build's style.css,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start with the theme the runtime's own widgets (checkboxes, selects,
// dialogs, scroll bars) take. The browser build's .high-contrast palette is
// a token set here, applied while the runtime's high-contrast option is on;
// the title's key art (assets/keyart.webp) is an image background with the
// page colour behind it while it loads.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
/** style.css .hw-root.high-contrast: black panels, white text and borders, a dark-green active state. */
const HIGH_CONTRAST: Tokens = {
  panel: "#000000", "panel-border": "#ffffff", text: "#ffffff", dim: "#ffffff", btn: "#000000", "btn-hover": "#1a1a1a",
  "btn-border": "#ffffff", primary: "#004d26", "primary-hover": "#006633", "primary-border": "#ffffff", pedal: "#000000",
  shade: "#000000", card: "#000000",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setTheme({
    fontSize: 16, smallSize: 14.4, headingSize: 18.4, padding: 8, spacing: 8, radius: 8,
    text: "#f0f4ee", muted: "#b8c8bc", panel: "#223028", control: "#2e3f34", hovered: "#3a4f42",
    pressed: "#26352c", field: "#2e3f34", accent: "#4ed88a", focus: "#f2c14e", outline: "#4a5c50",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$text" }, minHeight: 40,
      parts: { box: { background: "#16201a", border: { width: 2, color: "$btn-border" }, radius: 4 }, mark: { background: "$success" } },
    },
    select: { text: { color: "$text" }, background: "$btn", border: { width: 1, color: "$btn-border" }, radius: 6, minHeight: 36 },
    dialog: {
      background: "$panel", radius: 12, padding: 24, border: { width: 1, color: "$panel-border" },
      parts: { backdrop: { background: "#0c14108c" } },
    },
    scrollArea: { parts: { bar: { background: "$dim", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$text" }, radius: 6, padding: 6 },
    // style.css .hw-screen-layer[data-screen="title"]: the key art behind the title panel.
    ".keyart": { background: [{ image: "assets/keyart.webp", size: "cover", position: { x: 0.5, y: 0.35 } }, "#1c2a22"] },
  });
}

let hcKey: boolean | null = null;
/** The high-contrast tokens over the sheet's while the runtime's option is on. */
export function applyContrast(highContrast: boolean): void {
  if (hcKey === highContrast) return;
  hcKey = highContrast;
  ui.setTokens(highContrast ? { ...base, ...HIGH_CONTRAST } : base);
}
