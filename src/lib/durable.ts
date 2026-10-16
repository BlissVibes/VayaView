/**
 * Settings that must survive anything: stations, undo history, theme, track
 * choices. Each change is sent at once to the app's own process, which writes
 * it to a file in %APPDATA%\Parlor\store before answering. Browser storage is
 * not used for these: it holds writes back for a while, and a closed or killed
 * window loses whatever it was still holding.
 *
 * Reads are instant from memory, filled once at start-up by `loadDurable`.
 */
import { isRemote } from "./remote.ts";

const memory = new Map<string, string>();
const sending = new Set<string>();
const waiting = new Map<string, string | null>();
let ready = false;

export async function loadDurable(): Promise<void> {
  try {
    const response = await fetch("/api/store");
    const all = (await response.json()) as Record<string, string>;
    for (const [key, value] of Object.entries(all)) memory.set(key, value);
    ready = true;
  } catch {
    // The store could not be read. Fall back to browser storage for this session.
  }
}

/** One write per key in flight; a newer value waits and replaces any older one still waiting. */
async function send(key: string, value: string | null) {
  if (sending.has(key)) {
    waiting.set(key, value);
    return;
  }
  sending.add(key);
  try {
    await fetch(`/api/store?key=${encodeURIComponent(key)}`, {
      method: value == null ? "DELETE" : "PUT",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: value ?? undefined,
    });
  } catch {
    // Kept in memory and browser storage; the next change tries again.
  }
  sending.delete(key);
  if (waiting.has(key)) {
    const next = waiting.get(key) ?? null;
    waiting.delete(key);
    void send(key, next);
  }
}

function legacy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const durable = {
  getItem(key: string): string | null {
    if (memory.has(key)) return memory.get(key) ?? null;
    // First run after this change: bring over what browser storage had, once.
    const old = legacy(key);
    if (old != null && ready && !isRemote) {
      memory.set(key, old);
      void send(key, old);
    }
    return old;
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
    // A phone reads the PC's stations and settings but never writes them back.
    if (isRemote) return;
    if (ready) void send(key, value);
    else localStorage.setItem(key, value);
  },
  removeItem(key: string): void {
    memory.delete(key);
    if (ready && !isRemote) void send(key, null);
    try {
      localStorage.removeItem(key);
    } catch {
      // nothing to remove
    }
  },
};
