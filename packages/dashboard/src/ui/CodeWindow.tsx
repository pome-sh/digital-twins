// SPDX-License-Identifier: Apache-2.0
//
// The design system's CodeWindow: "near-black window with traffic lights and a
// mono filename — code, tapes, terminal output." The tape itself is one, and so
// is every snippet on the empty state, which is why the empty state and the
// live tape read as the same product.
import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CodeWindow(props: {
  title: ReactNode;
  /** Right-hand side of the title bar: a clock, a copy button. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg bg-dark text-on-dark", props.className)}>
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-dark-line pr-2 pl-4">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-dark-line" />
          <span className="size-2.5 rounded-full bg-dark-line" />
          <span className="size-2.5 rounded-full bg-dark-line" />
        </span>
        <span className="truncate font-mono text-xs text-on-dark-soft">{props.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">{props.actions}</span>
      </div>
      {props.children}
    </div>
  );
}

/** A snippet. Wrapped rather than scrolled: a masked token pushed off-screen is a token nobody can find. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="px-4 py-3.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-on-dark [overflow-wrap:anywhere]">
      {children}
    </pre>
  );
}

/** Copies `text` — the real text, even when the page is showing a masked one. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      className="text-on-dark-soft hover:bg-dark-elevated hover:text-on-dark"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
      {done ? "Copied" : label}
    </Button>
  );
}
