// SPDX-License-Identifier: Apache-2.0
//
// The design system's floating pill nav: "opaque cream pill, full radius, the
// one shadow" — mark and wordmark left, the twins in the middle, and on the
// right what this page is doing right now.
import { useEffect, useState } from "react";
import type { TwinSnapshot } from "@/api";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { hasFailures, quietFor } from "@/model/row";
import { Mark } from "./Mark";

/** A clock that moves once a second, for the "quiet for" counter. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function since(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function Nav(props: { twins: TwinSnapshot[]; current: TwinSnapshot; stopped: boolean }) {
  return (
    <header className="sticky top-0 z-30 shrink-0 px-4 pt-4 pb-3 sm:px-6">
      <nav className="mx-auto flex min-h-14 max-w-[1320px] flex-wrap items-center gap-x-6 gap-y-2 rounded-[28px] bg-background py-2 pr-5 pl-4 shadow-pome">
        <div className="flex items-center gap-2">
          <Mark className="size-6" />
          <span className="font-serif text-xl tracking-[-0.3px] text-ink">pome</span>
        </div>

        <TabsList aria-label="twins" className="h-9 rounded-full bg-card p-1">
          {props.twins.map((twin) => (
            <TabsTrigger
              key={twin.name}
              value={twin.name}
              // One sentence for a screen reader, instead of the name, a dot's
              // label and a bare number read out in that order.
              aria-label={`${twin.name} twin, ${twin.summary.requests} request${twin.summary.requests === 1 ? "" : "s"}${
                hasFailures(twin)
                  ? `, ${twin.summary.writes_not_landed} write${twin.summary.writes_not_landed === 1 ? "" : "s"} did not land`
                  : ""
              }`}
              className="group h-7 flex-none gap-2 rounded-full px-3.5 font-mono text-[13px] font-normal text-body data-[state=active]:bg-dark data-[state=active]:text-on-dark"
            >
              {twin.name}
              <span
                className={cn(
                  "flex items-center gap-1 tabular-nums",
                  // On the dark active pill the status red lifts to hold
                  // contrast, as the system asks of every status colour.
                  hasFailures(twin)
                    ? "text-fail group-data-[state=active]:text-fail-lift"
                    : "text-muted-soft group-data-[state=active]:text-on-dark-soft",
                )}
              >
                {hasFailures(twin) && (
                  <span
                    className="size-1.5 rounded-full bg-fail group-data-[state=active]:bg-fail-lift"
                    aria-hidden="true"
                  />
                )}
                {twin.summary.requests}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        <Status twin={props.current} stopped={props.stopped} />
      </nav>
    </header>
  );
}

/**
 * What the page is doing, in one line. Three live states, because a still page
 * must never read as a frozen one: `recording` while requests are landing,
 * `quiet 12s` when the agent has gone silent — the count keeps climbing, which
 * is the proof the page is still watching — and `watching` before the first.
 */
function Status(props: { twin: TwinSnapshot; stopped: boolean }) {
  const now = useNow();
  const port = new URL(props.twin.url).port;
  const quiet = quietFor(props.twin.entries, now);
  const state = props.stopped
    ? "stopped"
    : quiet === null
      ? "watching"
      : quiet < 5
        ? "recording"
        : `quiet ${since(quiet)}`;
  return (
    <div className="ml-auto flex items-center gap-2 font-mono text-[13px] text-body" role="status">
      <span
        className={cn(
          "size-2 rounded-full",
          props.stopped ? "bg-muted-soft" : "animate-breathe bg-moss",
        )}
      />
      <span>{state}</span>
      <span className="text-muted-soft">·</span>
      <span className="text-muted-foreground">
        {props.twin.name} on :{port}
      </span>
    </div>
  );
}
