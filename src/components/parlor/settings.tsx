import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { applyFonts, fileFamily, loadFonts, type FontChoice, type FontPick } from "@/lib/fonts";
import { LibraryBar } from "./library-bar";
import { PhoneAccess } from "./phone-access";
import { ThemePicker } from "./theme-picker";
import { TmdbBox } from "./tmdb-box";
import { VintageTv } from "./vintage-tv";

type SettingsProps = {
  /** Open straight into Vintage TV with this archive.org search (a free channel picked under Edit stations). */
  vintageQuery?: string | null;
  onClose: () => void;
  onRescan: () => void;
  scanLabel: string | null;
  onRefresh: () => Promise<unknown>;
  className?: string;
};

const button = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-40";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-screen p-4">
      <h3 className="mb-3 text-sm font-semibold tracking-wide text-cream/80">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Everything that is set once and left: updates, look, fonts, library, phone.
 * It takes the guide's place under the picture, like Edit stations.
 */
export function Settings({ onClose, onRescan, scanLabel, onRefresh, vintageQuery, className }: SettingsProps) {
  // Vintage TV is big enough to want the whole panel, so it opens in place of the settings.
  const [vintage, setVintage] = useState(Boolean(vintageQuery));
  if (vintage) return <VintageTv className={className} onClose={() => setVintage(false)} onRescan={onRescan} initialQuery={vintageQuery} />;
  return (
    <section aria-label="Settings" className={cn("flex min-h-0 flex-col overflow-hidden rounded-screen bg-bezel text-cream", className)}>
      <header className="flex shrink-0 items-center gap-4 border-b border-screen px-4 py-2">
        <h2 className="text-lg">Settings</h2>
        <button type="button" onClick={onClose} className={cn(button, "ml-auto")}>
          Back to guide
        </button>
      </header>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 xl:grid-cols-2">
        <Section title="Updates">
          <Updates />
        </Section>
        <Section title="Look">
          <ThemePicker />
          <Fonts />
        </Section>
        <Section title="Library">
          <LibraryBar />
          <button type="button" className={cn(button, "mt-2")} disabled={scanLabel != null} onClick={onRescan}>
            {scanLabel ?? "Rescan library now"}
          </button>
          <TmdbBox onRefresh={onRefresh} />
        </Section>
        <Section title="Phone">
          <PhoneAccess />
        </Section>
        <Section title="Vintage TV">
          <p className="mb-3 text-xs text-cream/60">
            Old cartoons, Saturday mornings and whole days taped off TV, from the Internet Archive. Downloads go into a folder that joins your library.
          </p>
          <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-room hover:opacity-90" onClick={() => setVintage(true)}>
            Open Vintage TV
          </button>
        </Section>
      </div>
    </section>
  );
}

type UpdateStatus = {
  supported: boolean;
  current: string;
  latest: string | null;
  available: boolean;
  notes?: string;
  error?: string;
  /** Set when the last update did not finish (found at start-up). */
  notice?: string | null;
  phase?: "idle" | "downloading" | "installing";
  progress?: number;
};

/** Checks GitHub for a newer VayaView. Installing replaces this copy in place and restarts. */
function Updates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(fresh = false) {
    setBusy(true);
    try {
      setStatus((await (await fetch(`/api/update${fresh ? "?fresh=1" : ""}`)).json()) as UpdateStatus);
    } catch {
      setStatus(null);
    }
    setBusy(false);
  }

  useEffect(() => {
    void check();
  }, []);

  useEffect(() => {
    if (status?.phase !== "downloading" && status?.phase !== "installing") return;
    const timer = window.setInterval(check, 1000);
    return () => window.clearInterval(timer);
  }, [status?.phase]);

  async function install() {
    setBusy(true);
    await fetch("/api/update/install", { method: "POST" }).catch(() => null);
    await check();
  }

  if (!status) return <p className="text-xs text-cream/50">{busy ? "Checking…" : "Could not check for updates."}</p>;
  if (!status.supported) return <p className="text-xs text-cream/50">Updates work in the installed VayaView app.</p>;
  return (
    <div className="space-y-2 text-xs">
      <p className="text-cream/70">
        This is VayaView <span className="font-semibold text-cream">{status.current}</span>.{" "}
        {status.error
          ? <span className="text-accent">{status.error}</span>
          : status.phase === "downloading"
            ? `Downloading ${status.latest}… ${Math.round((status.progress ?? 0) * 100)}%`
            : status.phase === "installing"
              ? "Installing. VayaView will close and open again by itself."
              : status.available
                ? `Version ${status.latest} is out.`
                : status.latest
                  ? "You have the newest version."
                  : "No versions have been published yet."}
      </p>
      {status.notice ? <p className="text-accent">{status.notice}</p> : null}
      {status.available && status.notes ? <p className="whitespace-pre-line text-cream/50">{status.notes}</p> : null}
      <div className="flex gap-2">
        {status.available && status.phase !== "downloading" && status.phase !== "installing" ? (
          <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-room" disabled={busy} onClick={install}>
            Update to {status.latest}
          </button>
        ) : null}
        <button type="button" className={button} disabled={busy} onClick={() => check(true)}>
          Check again
        </button>
      </div>
    </div>
  );
}

type LocalFont = { family: string };

/** Pick fonts for the main text and for titles: installed on this PC, or a font file added here. */
function Fonts() {
  const [choice, setChoice] = useState<FontChoice>(loadFonts);
  const [system, setSystem] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadFiles() {
    try {
      setFiles((await (await fetch("/api/fonts")).json()) as string[]);
    } catch {
      setFiles([]);
    }
  }

  useEffect(() => {
    void loadFiles();
  }, []);

  async function listInstalled() {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFont[]> }).queryLocalFonts;
    if (!query) return setNote("This window cannot list installed fonts. Add a font file instead.");
    try {
      const fonts = await query();
      setSystem([...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b)));
      setNote(null);
    } catch {
      setNote("Listing installed fonts was not allowed. Add a font file instead.");
    }
  }

  async function addFile(file: File) {
    const response = await fetch(`/api/fonts?name=${encodeURIComponent(file.name)}`, { method: "PUT", body: file });
    if (!response.ok) return setNote(`${file.name} could not be added. Use a .ttf, .otf, .woff or .woff2 file.`);
    setNote(`Added ${file.name}. Pick it below.`);
    await loadFiles();
  }

  function pick(slot: keyof FontChoice, value: string) {
    const next: FontPick = value === "" ? { kind: "default" } : value.startsWith("file:") ? { kind: "file", file: value.slice(5) } : { kind: "system", family: value.slice(4) };
    const all = { ...choice, [slot]: next };
    setChoice(all);
    void applyFonts(all);
  }

  const valueOf = (font: FontPick) => (font.kind === "file" ? `file:${font.file}` : font.kind === "system" ? `sys:${font.family}` : "");
  const selector = (slot: keyof FontChoice, label: string) => {
    const current = choice[slot];
    // Keep the saved installed font listed even before the full list is loaded.
    const families = current.kind === "system" && !system.includes(current.family) ? [current.family, ...system] : system;
    return (
      <label className="flex items-center gap-2 text-xs text-cream/60">
        <span className="w-28 shrink-0">{label}</span>
        <select
          value={valueOf(current)}
          onChange={(event) => pick(slot, event.target.value)}
          className="min-w-0 flex-1 rounded-md bg-black/60 px-2 py-1.5 text-xs text-cream outline-1 outline-cream/20"
        >
          <option value="">Built-in (Outfit)</option>
          {files.length > 0 ? (
            <optgroup label="Added font files">
              {files.map((file) => (
                <option key={file} value={`file:${file}`}>
                  {fileFamily(file).slice(3)}
                </option>
              ))}
            </optgroup>
          ) : null}
          {families.length > 0 ? (
            <optgroup label="Installed on this PC">
              {families.map((family) => (
                <option key={family} value={`sys:${family}`} style={{ fontFamily: family }}>
                  {family}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
    );
  };

  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs text-cream/70">Fonts</p>
      {selector("main", "Main text")}
      {selector("title", "Titles & numbers")}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={listInstalled}>
          Show fonts installed on this PC
        </button>
        <button type="button" className={button} onClick={() => fileRef.current?.click()}>
          Add a font file…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void addFile(file);
            event.target.value = "";
          }}
        />
      </div>
      {note ? <p className="text-xs text-cream/50">{note}</p> : null}
    </div>
  );
}
