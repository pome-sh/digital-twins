// SPDX-License-Identifier: Apache-2.0
//
// The page once the agent has done something: the verdict, then the tape beside
// the world. On a desktop the three share one screen and only the tape scrolls,
// so the answer to "which write did not land" is never scrolled away from.
import { useState } from "react";
import { ArrowDownIcon } from "@phosphor-icons/react";
import type { TwinSnapshot } from "@/api";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { failureIndexes, nextFailure } from "@/model/row";
import { Tape } from "./Tape";
import { World } from "./World";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Live({ twin, stopped }: { twin: TwinSnapshot; stopped: boolean }) {
  // Three things decide which row is open. The reader's pick wins. Failing
  // that, the latest failure opens by itself — on a live tape it is the one
  // they have not seen yet — unless they closed it, in which case only a NEWER
  // failure opens itself again. Without that last rule a failure could never be
  // closed: the next poll would reopen it.
  const [picked, setPicked] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(-1);
  const [reveal, setReveal] = useState(0);

  const failures = failureIndexes(twin.entries).map((offset) => twin.dropped + offset);
  const latest = failures.at(-1) ?? null;
  const open = picked ?? (latest !== null && latest > dismissed ? latest : null);

  const onOpen = (index: number | null) => {
    setPicked(index);
    if (index === null && latest !== null) setDismissed(latest);
  };

  const stepToNextFailure = () => {
    const current = open === null ? null : open - twin.dropped;
    const next = nextFailure(twin.entries, current);
    if (next === null) return;
    setPicked(twin.dropped + next);
    setReveal((count) => count + 1);
  };

  const { summary } = twin;
  const fails = summary.writes_not_landed;

  return (
    <section className="mx-auto flex w-full max-w-[1320px] flex-1 flex-col gap-5 px-4 pb-6 sm:px-6 lg:min-h-0">
      <div className="shrink-0 px-2 pt-1">
        <p className="flex flex-wrap items-center gap-x-3.5 gap-y-2 font-serif text-[30px] leading-tight tracking-[-0.5px] text-ink">
          <span>{plural(summary.requests, "request")}</span>
          <Sep />
          <span>{summary.changed_state} changed state</span>
          <Sep />
          {fails > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={stepToNextFailure}
                  className="h-auto rounded-md bg-fail px-3.5 py-1.5 font-sans text-xl font-medium tracking-normal text-white active:bg-fail"
                >
                  {plural(fails, "write")} did not land
                  <ArrowDownIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{fails === 1 ? "Show it on the tape" : "Show the next one on the tape"}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-muted-foreground">0 writes did not land</span>
          )}
          <Sep />
          <span className="text-muted-foreground">{summary.unsupported} unsupported</span>
          <Sep />
          <span className="text-muted-foreground">{plural(summary.reads, "read")}</span>
        </p>
        <p className="mt-2.5 text-sm text-muted-foreground">
          {fails === 0
            ? "Every write the agent made landed."
            : fails === 1
              ? "A write the agent made did not land. Its detail is open on the tape: what the twin recorded for it."
              : `${fails} writes the agent made did not land. ${
                  open === latest ? "The latest is open on the tape" : "One is open on the tape"
                } — the count steps through them.`}
        </p>
      </div>

      <div className="grid flex-1 gap-5 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <Tape
          twin={twin}
          stopped={stopped}
          open={open}
          onOpen={onOpen}
          reveal={reveal}
          className="h-[72vh] lg:h-auto lg:min-h-0"
        />
        <World twin={twin} className="self-start lg:max-h-full lg:overflow-y-auto" />
      </div>
    </section>
  );
}

function Sep() {
  return (
    <span className="text-border" aria-hidden="true">
      ·
    </span>
  );
}
