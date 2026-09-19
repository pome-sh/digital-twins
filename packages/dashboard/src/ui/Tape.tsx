// SPDX-License-Identifier: Apache-2.0
//
// The tape, as the design system draws a trace window: dark, rounded, three dim
// traffic lights, a mono title, mono column heads, "the failing row gets a
// faint red row tint", and a footer that says the outcome in one sentence.
//
// It scrolls inside itself so the verdict above and the world beside it stay on
// screen however long the session runs — the answer to "which write did not
// land" must not scroll away with the question. It follows its newest row the
// way a log does, and stops following the moment the reader scrolls up.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import type { TapeEntry, TwinSnapshot } from "@/api";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  clockOf,
  entryKey,
  kindOf,
  methodChip,
  OUTCOME,
  requestLabel,
  statusText,
  type Kind,
} from "@/model/row";
import { CodeWindow } from "./CodeWindow";
import { Detail } from "./Detail";

const COLUMNS = "grid grid-cols-[12px_64px_52px_minmax(0,1fr)_48px_minmax(0,172px)] items-center gap-3";

/** Within this many pixels of the end counts as "at the end". */
const FOLLOW_SLACK = 24;

export function Tape(props: {
  twin: TwinSnapshot;
  stopped: boolean;
  /** Absolute index (counting rows behind the window) of the open entry. */
  open: number | null;
  onOpen: (index: number | null) => void;
  /** Bumped to ask the tape to bring `open` into view. */
  reveal: number;
  className?: string;
}) {
  const { twin } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const total = twin.dropped + twin.entries.length;
  const seenTotal = useRef(total);
  const firstTotal = useRef(total);
  const worldPaths = twin.world.map((collection) => collection.path);

  // New rows: follow them if the reader is at the end, count them if not.
  useLayoutEffect(() => {
    const grew = total - seenTotal.current;
    seenTotal.current = total;
    const el = viewport.current;
    if (el === null) return;
    if (grew < 0 || following.current) el.scrollTop = el.scrollHeight;
    else if (grew > 0) setUnseen((count) => count + grew);
  }, [total]);

  // A request from the verdict to show a particular failure.
  useEffect(() => {
    if (props.reveal === 0 || props.open === null) return;
    viewport.current
      ?.querySelector(`[data-index="${props.open}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [props.reveal, props.open]);

  const onScroll = () => {
    const el = viewport.current;
    if (el === null) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK;
    if (following.current) setUnseen(0);
  };

  const toEnd = () => {
    const el = viewport.current;
    if (el === null) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    following.current = true;
    setUnseen(0);
  };

  const last = twin.entries.at(-1);

  return (
    <CodeWindow
      className={props.className}
      title={`tape · ${twin.name} twin`}
      actions={last ? <span className="pr-2 font-mono text-xs text-on-dark-soft">{clockOf(last.ts)}</span> : null}
    >
      <div
        className={cn(COLUMNS, "shrink-0 border-b border-dark-line px-4 py-2 font-mono text-[11px] tracking-[1.4px] text-on-dark-soft/70 uppercase")}
        aria-hidden="true"
      >
        <span />
        <span>time</span>
        <span />
        <span>what the agent did</span>
        <span className="text-right">status</span>
        <span>outcome</span>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1" viewportRef={viewport} onViewportScroll={onScroll}>
          <div className="py-1" role="list" aria-label={`requests to the ${twin.name} twin`}>
            {twin.dropped > 0 && (
              <p className="px-4 py-2.5 font-mono text-xs text-on-dark-soft/70">
                {twin.dropped} earlier request{twin.dropped === 1 ? " is" : "s are"} on the tape above
                this window. The counts include {twin.dropped === 1 ? "it" : "them"}.
              </p>
            )}
            {twin.entries.map((entry, offset) => {
              const index = twin.dropped + offset;
              return (
                <Row
                  key={entryKey(entry, index)}
                  entry={entry}
                  index={index}
                  selected={props.open === index}
                  // Only rows that land after the page opened rise into place;
                  // the ones already on the tape are simply there.
                  fresh={index >= firstTotal.current}
                  worldPaths={worldPaths}
                  onToggle={() => props.onOpen(props.open === index ? null : index)}
                />
              );
            })}
          </div>
        </ScrollArea>

        {unseen > 0 && (
          <button
            type="button"
            onClick={toEnd}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full bg-on-dark px-3 py-1 font-mono text-xs text-dark shadow-pome"
          >
            {unseen} new <ArrowDownIcon className="size-3" />
          </button>
        )}
      </div>

      <Footer twin={twin} stopped={props.stopped} />
    </CodeWindow>
  );
}

function Row(props: {
  entry: TapeEntry;
  index: number;
  selected: boolean;
  fresh: boolean;
  worldPaths: string[];
  onToggle: () => void;
}) {
  const { entry } = props;
  const kind = kindOf(entry);
  return (
    <div role="listitem" data-index={props.index}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-expanded={props.selected}
            onClick={props.onToggle}
            className={cn(
              COLUMNS,
              "w-full cursor-pointer border-l-2 border-transparent px-4 py-2 text-left transition-colors duration-120 ease-(--ease-pome) hover:bg-on-dark/[0.03]",
              // "The failing row gets a faint red row tint." — no more than that.
              kind === "fail" && "border-fail bg-fail/12 hover:bg-fail/16",
              props.selected && kind !== "fail" && "bg-on-dark/[0.06] hover:bg-on-dark/[0.06]",
              props.fresh && "animate-land",
            )}
          >
            <span className="font-mono text-xs text-on-dark">{props.selected ? "▸" : ""}</span>
            <span className="font-mono text-[12.5px] text-on-dark-soft/60 tabular-nums">{clockOf(entry.ts)}</span>
            <span
              className={cn(
                "rounded-sm border px-1 py-0.5 text-center font-mono text-[10.5px] tracking-[0.6px]",
                kind === "fail" ? "border-fail-lift/40 text-fail-lift" : "border-dark-line text-on-dark-soft/70",
              )}
            >
              {methodChip(entry)}
            </span>
            <span
              className={cn(
                "truncate font-mono text-sm",
                // Reads recede. If reads are loud, the failure is lost.
                kind === "read" ? "text-on-dark/45" : "text-on-dark",
              )}
            >
              {requestLabel(entry)}
            </span>
            <span className={cn("text-right font-mono text-[13px] tabular-nums", statusTone(kind))}>
              {entry.status}
            </span>
            <Outcome kind={kind} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="[--tip:var(--pome-surface-dark-elevated)]">
          {entry.method} {entry.path} · {statusText(entry.status)}
        </TooltipContent>
      </Tooltip>
      {props.selected && <Detail entry={entry} kind={kind} worldPaths={props.worldPaths} />}
    </div>
  );
}

function statusTone(kind: Kind): string {
  switch (kind) {
    case "fail":
      return "font-medium text-fail-lift";
    case "unmodelled":
      return "text-warn-lift";
    case "read":
      return "text-on-dark-soft/60";
    case "changed":
      return "text-on-dark-soft";
  }
}

/** The system's status badge: "a pill with a pass/warn/fail dot". A read is not a status. */
function Outcome({ kind }: { kind: Kind }) {
  if (kind === "read") return <span className="text-[13px] text-on-dark-soft/50">read</span>;
  const tone = {
    changed: "text-moss-lift",
    unmodelled: "border-warn-lift/40 text-warn-lift",
    fail: "bg-fail/25 text-fail-lift",
  }[kind];
  return (
    <Badge
      variant="outline"
      className={cn(
        "justify-self-start gap-1.5 border-transparent px-2 font-sans text-[12.5px] font-normal",
        tone,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {OUTCOME[kind]}
    </Badge>
  );
}

/**
 * "Footer: status dot + '9 of 10 tasks passed', the failure explained in one
 * sentence." Says which write did not land, not just how many — the verdict
 * above already has the count.
 */
function Footer({ twin, stopped }: { twin: TwinSnapshot; stopped: boolean }) {
  const { summary } = twin;
  const writes = summary.changed_state + summary.writes_not_landed;
  const lastFailure = [...twin.entries].reverse().find((entry) => kindOf(entry) === "fail");
  const dot = stopped
    ? "bg-on-dark-soft/60"
    : summary.writes_not_landed > 0
      ? "bg-fail-lift"
      : summary.unsupported > 0
        ? "bg-warn-lift"
        : "bg-moss-lift";

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-dark-line px-4 py-2.5 text-[13px] text-on-dark-soft">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} />
      {stopped ? (
        <span>
          <span className="text-on-dark">The twin stopped.</span> You pressed Ctrl-C — the tape is
          everything that was recorded, and nothing more will arrive.
        </span>
      ) : lastFailure ? (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">
            {summary.changed_state} of {writes} writes landed. The latest that did not:
          </span>
          <span className="truncate rounded-sm bg-dark-elevated px-1.5 py-0.5 font-mono text-xs text-on-dark">
            {lastFailure.method} {lastFailure.path}
          </span>
          <span className="shrink-0 font-mono text-xs text-fail-lift">{statusText(lastFailure.status)}</span>
        </span>
      ) : writes > 0 ? (
        <span>
          Every write landed — {writes} of {writes}.
          {summary.unsupported > 0 &&
            ` ${summary.unsupported} call${summary.unsupported === 1 ? "" : "s"} this twin does not model.`}
        </span>
      ) : (
        <span>Only reads so far — nothing has tried to change the world yet.</span>
      )}
    </div>
  );
}
