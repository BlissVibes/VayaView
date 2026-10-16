import { durable } from "./durable.ts";
/**
 * Colour themes. The stylesheet reads five variables (see styles.css), so a
 * theme is five colours written onto the root element. Nothing is rebuilt.
 */
export type Theme = {
  id: string;
  name: string;
  /** Highlights: the tuned station, the now line, progress. */
  accent: string;
  /** Window background. */
  room: string;
  /** Panels. */
  bezel: string;
  /** Wells and dividers. */
  screen: string;
  /** Text. */
  cream: string;
};

export const THEMES: Theme[] = [
  { id: "ember", name: "Ember", accent: "#ff4d3a", room: "#12100e", bezel: "#231e19", screen: "#070605", cream: "#f3eee6" },
  { id: "ocean", name: "Ocean", accent: "#3aa0ff", room: "#0b1016", bezel: "#151d27", screen: "#05080c", cream: "#e8eef5" },
  { id: "emerald", name: "Emerald", accent: "#2fd08a", room: "#0c120f", bezel: "#17211c", screen: "#050806", cream: "#e9f2ec" },
  { id: "violet", name: "Violet", accent: "#a678ff", room: "#100e16", bezel: "#1c1927", screen: "#07060b", cream: "#eeeaf6" },
  { id: "gold", name: "Gold", accent: "#f5b83d", room: "#12100b", bezel: "#221e14", screen: "#080705", cream: "#f4efe2" },
  { id: "rose", name: "Rose", accent: "#ff5fa2", room: "#140d11", bezel: "#24171e", screen: "#090507", cream: "#f6eaf0" },
  { id: "teal", name: "Teal", accent: "#2cc7d1", room: "#0a1213", bezel: "#142022", screen: "#040809", cream: "#e6f1f2" },
  { id: "slate", name: "Slate", accent: "#c9d1d9", room: "#0d0f12", bezel: "#191c21", screen: "#060709", cream: "#eceff3" },
];

/** `accent` overrides the theme's own highlight when the user picked a custom colour. */
export type ThemeChoice = { id: string; accent: string | null };

/** Colours a station's bar can take in the guide. */
export const CHANNEL_COLORS = ["#ff4d3a", "#f5b83d", "#2fd08a", "#2cc7d1", "#3aa0ff", "#a678ff", "#ff5fa2", "#c9d1d9"];

const KEY = "parlor.theme";

export function loadTheme(): ThemeChoice {
  try {
    const saved = JSON.parse(durable.getItem(KEY) ?? "null") as Partial<ThemeChoice> | null;
    const accent = typeof saved?.accent === "string" && /^#[0-9a-f]{6}$/i.test(saved.accent) ? saved.accent : null;
    return { id: THEMES.some((theme) => theme.id === saved?.id) ? (saved?.id as string) : "ember", accent };
  } catch {
    return { id: "ember", accent: null };
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const theme = THEMES.find((item) => item.id === choice.id) ?? THEMES[0]!;
  const root = document.documentElement.style;
  root.setProperty("--color-accent", choice.accent ?? theme.accent);
  root.setProperty("--color-room", theme.room);
  root.setProperty("--color-bezel", theme.bezel);
  root.setProperty("--color-screen", theme.screen);
  root.setProperty("--color-cream", theme.cream);
  try {
    durable.setItem(KEY, JSON.stringify(choice));
  } catch {
    // Still applied for this session.
  }
}
