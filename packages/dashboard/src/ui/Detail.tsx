// SPDX-License-Identifier: Apache-2.0
//
// What one request changed, as the twin reported it — and an honest sentence
// when it reported nothing, which is the common case for a read and the whole
// point for a write that did not land.
import { useState } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";
import type { TapeEntry } from "@/api";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { detailNote, foldLabel, splitFields, type FieldRow } from "@/model/fields";
import { clockOf, requestLabel, statusText, type Kind } from "@/model/row";

const MARK_TONE: Record<FieldRow["mark"], string> = {
  "+": "text-moss-lift",
  "−": "text-fail-lift",
  "~": "text-warn-lift",
  // Sat still. Dim, so a folded field is never drawn as an arrival.
  "·": "text-on-dark-soft/40",
};

export function Detail(props: { entry: TapeEntry; kind: Kind; worldPaths: string[] }) {
  const [open, setOpen] = useState(false);
  const split = splitFields(props.entry.delta, props.worldPaths);
  const { lead, rest } = split;

  return (
    <div className="mt-1 mr-4 mb-3 ml-9 border-l-2 border-on-dark-soft/30 pl-4">
      <div className="flex items-baseline justify-between gap-4 pt-1 pb-2">
        <span className="min-w-0 truncate font-mono text-[13px] text-on-dark">
          {clockOf(props.entry.ts)}  {props.entry.method} {requestLabel(props.entry)}
          <span className="ml-2 text-on-dark-soft/70">{statusText(props.entry.status)}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] tracking-[1.4px] text-on-dark-soft/60 uppercase">
          {split.kind === "none" ? "what the twin recorded" : "what this call changed"}
        </span>
      </div>

      {lead.map((row) => (
        <Field key={row.field} row={row} />
      ))}

      {rest.length > 0 && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleContent className="mt-1 border-t border-dark-line pt-2">
            {rest.map((row) => (
              <Field key={row.field} row={row} />
            ))}
          </CollapsibleContent>
          <CollapsibleTrigger className="mt-1.5 mb-1 flex cursor-pointer items-center gap-1 text-[13px] text-on-dark-soft transition-colors duration-120 hover:text-on-dark">
            <CaretRightIcon className={cn("size-3 transition-transform duration-120", open && "rotate-90")} />
            {foldLabel(rest.length, open)}
          </CollapsibleTrigger>
        </Collapsible>
      )}

      <p className="max-w-[60ch] py-1.5 text-[13px] leading-relaxed text-on-dark-soft">{noteFor(props.kind, split)}</p>
    </div>
  );
}

function Field({ row }: { row: FieldRow }) {
  return (
    <div className="grid grid-cols-[14px_136px_minmax(0,1fr)] gap-3 py-0.5 font-mono text-[13px] leading-relaxed">
      <span className={MARK_TONE[row.mark]}>{row.mark}</span>
      <span className="truncate text-on-dark-soft">{row.field}</span>
      <span className={cn("break-words", row.empty ? "text-on-dark-soft/50" : "text-on-dark")}>{row.value}</span>
    </div>
  );
}

/**
 * The sentence under a detail. Never claims completeness: the twins genuinely
 * differ in how much of a mutation they report, and a panel implying otherwise
 * would be worse than no panel.
 */
function noteFor(kind: Kind, split: ReturnType<typeof splitFields>): string {
  if (kind === "fail") {
    return "Nothing changed. The twin reported no detail for this call — there is no before and no after, because the write never landed.";
  }
  if (kind === "unmodelled") {
    return "This call is not modelled by this twin, so there is nothing to report. Not a failure.";
  }
  return detailNote(split);
}
