import { durable } from "./durable.ts";

/**
 * Two font slots: the main text, and the big titles and station numbers. Each is the
 * built-in font, a font already installed on this PC, or a font file the user added
 * (kept in Data\fonts). Applied by setting two CSS variables on the page.
 */
export type FontPick = { kind: "default" } | { kind: "system"; family: string } | { kind: "file"; file: string };
export type FontChoice = { main: FontPick; title: FontPick };

const KEY = "parlor.fonts";
const FALLBACK = 'ui-sans-serif, system-ui, sans-serif';
const DEFAULT_STACK = `"Outfit", ${FALLBACK}`;

export function loadFonts(): FontChoice {
  try {
    const saved = JSON.parse(durable.getItem(KEY) ?? "null") as FontChoice | null;
    if (saved?.main && saved?.title) return saved;
  } catch {
    // Unreadable: use the defaults.
  }
  return { main: { kind: "default" }, title: { kind: "default" } };
}

/** The CSS family name for a font file: its file name without the extension. */
export const fileFamily = (file: string) => `VV ${file.replace(/\.[^.]+$/, "")}`;

async function stack(pick: FontPick): Promise<string> {
  if (pick.kind === "system") return `"${pick.family}", ${FALLBACK}`;
  if (pick.kind === "file") {
    const family = fileFamily(pick.file);
    try {
      const face = new FontFace(family, `url(/api/fonts/file/${encodeURIComponent(pick.file)})`);
      document.fonts.add(await face.load());
    } catch {
      return DEFAULT_STACK;
    }
    return `"${family}", ${FALLBACK}`;
  }
  return DEFAULT_STACK;
}

export async function applyFonts(choice: FontChoice, save = true): Promise<void> {
  const root = document.documentElement.style;
  root.setProperty("--font-sans", await stack(choice.main));
  root.setProperty("--font-title", await stack(choice.title));
  if (save) durable.setItem(KEY, JSON.stringify(choice));
}
