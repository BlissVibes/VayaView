import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

type PhoneStatus = { enabled: boolean; pin: string; paired: number; addresses: string[]; available: boolean };

const button = "rounded-md bg-cream/10 px-3 py-1.5 text-xs text-cream hover:bg-cream/20 disabled:opacity-40";

/** The switch for watching on a phone over home Wi-Fi, the PIN, and where to point the phone. */
export function PhoneAccess() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(body?: object) {
    setBusy(true);
    try {
      const response = await fetch("/api/phone", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
      setStatus((await response.json()) as PhoneStatus);
    } catch {
      setStatus(null);
    }
    setBusy(false);
  }

  useEffect(() => {
    void send();
  }, []);

  if (!status) return <p className="px-1 pb-1 text-xs text-cream/50">Checking phone access…</p>;
  if (!status.available) return <p className="px-1 pb-1 text-xs text-cream/50">Phone access works in the installed VayaView app.</p>;

  return (
    <div className="space-y-2 px-1 pb-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          disabled={busy}
          onClick={() => send({ enabled: !status.enabled })}
          className={cn("rounded-full px-3 py-1.5 font-medium", status.enabled ? "bg-accent text-room" : "bg-cream/10 text-cream")}
        >
          Phone access: {status.enabled ? "On" : "Off"}
        </button>
        <span className="text-cream/50">{status.enabled ? "Listening on your home Wi-Fi." : "Off: nothing outside this PC can reach VayaView."}</span>
      </div>
      {status.enabled ? (
        <div className="rounded-lg bg-screen p-3">
          <p className="text-cream/70">On your iPhone, open Safari and go to:</p>
          {status.addresses.length === 0 ? (
            <p className="mt-1 text-accent">No home network found on this PC.</p>
          ) : (
            status.addresses.map((address) => (
              <p key={address} className="mt-1 text-base font-semibold tracking-tight text-cream select-all">
                {address}
              </p>
            ))
          )}
          <p className="mt-2 text-cream/70">
            PIN <span className="ml-1 text-base font-semibold tracking-[0.3em] text-cream tabular-nums">{status.pin}</span>
          </p>
          <p className="mt-2 text-cream/45">
            {status.paired} phone{status.paired === 1 ? "" : "s"} paired. The first time, Windows may ask whether to let VayaView use the network: allow it on private networks.
          </p>
          <button type="button" className={cn(button, "mt-2")} disabled={busy} onClick={() => send({ forget: true })}>
            New PIN and forget paired phones
          </button>
        </div>
      ) : null}
    </div>
  );
}
