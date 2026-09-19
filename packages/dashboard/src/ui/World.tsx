// SPDX-License-Identifier: Apache-2.0
//
// The twin's world, and how far it has moved since it booted. This panel is the
// proof there is a real stateful service behind the tape and not a mock
// returning canned JSON: `issues 1 → 2` ticking in the same beat as the
// `create_issue` row landing is the whole product insight (F-1850 · D3).
import { useRef } from "react";
import type { TwinSnapshot, WorldCollection } from "@/api";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { arrivalOf, collectionLabel, hasMoved, worldView } from "@/model/world";

const head = "h-8 px-0 font-mono text-[11px] font-normal tracking-[1.4px] uppercase text-muted-soft";

/**
 * Which values appeared AFTER this panel first rendered. Only those tick.
 *
 * Keyed by value, so a count that changes remounts its cell and the tick plays
 * exactly once; the values present on first paint never tick, so opening the
 * page does not flash every number at once — which would be the opposite of
 * "one beat".
 */
function useFresh(rows: readonly WorldCollection[]) {
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null) {
    initial.current = new Set(
      rows.flatMap((row) => {
        const arrival = arrivalOf(row);
        return [`${row.path}=${row.now}`, ...(arrival ? [`${row.path}@${arrival.id}:${arrival.what}`] : [])];
      }),
    );
  }
  const seen = initial.current;
  return {
    count: (row: WorldCollection) => !seen.has(`${row.path}=${row.now}`),
    arrival: (row: WorldCollection, id: string, what: string) => !seen.has(`${row.path}@${id}:${what}`),
  };
}

export function World(props: { twin: TwinSnapshot; seeded?: boolean; className?: string }) {
  const { rows, hidden } = worldView(props.twin.world);
  const moved = rows.some(hasMoved);
  const fresh = useFresh(rows);

  return (
    <Card className={cn("gap-3 px-6 py-5", props.className)}>
      <div>
        <h2 className="font-serif text-xl tracking-[-0.3px] text-ink">The world</h2>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
          {props.seeded ? "seeded at boot" : `${props.twin.name} · moved since boot`}
        </p>
      </div>

      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={head}>collection</TableHead>
            {props.seeded ? (
              <TableHead className={cn(head, "w-14 text-right")}>rows</TableHead>
            ) : (
              <>
                <TableHead className={cn(head, "w-10 text-right")}>boot</TableHead>
                <TableHead className="w-5 px-0" />
                <TableHead className={cn(head, "w-10 text-right")}>now</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const rowMoved = hasMoved(row);
            const arrival = arrivalOf(row);
            return (
              <TableRow key={row.path} className="hover:bg-transparent" title={row.path}>
                <TableCell className="px-0 py-2.5 align-top whitespace-normal">
                  <div
                    className={cn(
                      "truncate font-mono text-[13px]",
                      rowMoved ? "font-medium text-ink" : "text-muted-foreground",
                    )}
                  >
                    {collectionLabel(row.path)}
                  </div>
                  {arrival && (
                    <div
                      key={`${arrival.id}:${arrival.what}`}
                      className={cn(
                        "mt-1.5 flex min-w-0 items-baseline gap-2",
                        fresh.arrival(row, arrival.id, arrival.what) && "animate-land",
                      )}
                    >
                      <span
                        className="min-w-0 truncate rounded-sm bg-background px-1.5 py-0.5 font-mono text-xs font-medium text-moss"
                        title={arrival.id}
                      >
                        {arrival.id}
                      </span>
                      <span className="shrink-0 text-xs text-body">{arrival.what}</span>
                    </div>
                  )}
                </TableCell>
                {props.seeded ? (
                  <TableCell className="px-0 py-2.5 text-right align-top font-mono text-sm text-body-strong tabular-nums">
                    {row.now}
                  </TableCell>
                ) : (
                  <>
                    <TableCell className="px-0 py-2.5 text-right align-top font-mono text-sm text-muted-foreground tabular-nums">
                      {row.boot}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "px-0 py-2.5 text-center align-top font-mono text-xs",
                        rowMoved ? "text-moss" : "text-border",
                      )}
                    >
                      →
                    </TableCell>
                    <TableCell className="px-0 py-2.5 text-right align-top">
                      <span
                        key={row.now}
                        className={cn(
                          "inline-block rounded-sm px-1 font-mono text-sm tabular-nums",
                          rowMoved ? "font-medium text-moss" : "text-muted-foreground",
                          fresh.count(row) && "animate-tick",
                        )}
                      >
                        {row.now}
                      </span>
                    </TableCell>
                  </>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {moved
          ? "Unchanged collections stay listed. They are what makes a change legible."
          : "A real stateful twin, already seeded. Nothing has moved it yet."}
        {hidden > 0 && (
          <span className="text-muted-soft">
            {" "}
            {hidden} more {hidden === 1 ? "collection" : "collections"} nothing has touched{" "}
            {hidden === 1 ? "is" : "are"} not listed.
          </span>
        )}
      </p>
    </Card>
  );
}
