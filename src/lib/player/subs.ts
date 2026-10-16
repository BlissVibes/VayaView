/** A subtitle line, in seconds from the start of the film. */
export type Cue = { start: number; end: number; text: string };

function stamp(value: string): number {
  return value
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

function parseBlock(block: string, shift: number): Cue | null {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => line.includes("-->"));
  if (at < 0) return null;
  const [from, to] = (lines[at] ?? "").split("-->");
  const text = lines
    .slice(at + 1)
    .join("\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .trim();
  if (!text || !from || !to) return null;
  const start = stamp(from) + shift;
  const end = stamp(to.trim().split(" ")[0] ?? "") + shift;
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end, text } : null;
}

/**
 * Reads WebVTT as it arrives, so lines show up before ffmpeg has finished
 * walking the file. `shift` is where in the film the extraction began.
 */
export async function streamCues(url: string, shift: number, signal: AbortSignal, onCue: (cue: Cue) => void): Promise<void> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) return;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += value.replace(/\r/g, "");
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const cue = parseBlock(buffer.slice(0, cut), shift);
        if (cue) onCue(cue);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
      }
      if (done) {
        const cue = parseBlock(buffer, shift);
        if (cue) onCue(cue);
        return;
      }
    }
  } catch {
    // Aborted on a channel change, or the track would not convert. No subtitles, no crash.
  }
}
