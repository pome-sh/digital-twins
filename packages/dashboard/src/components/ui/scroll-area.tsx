// SPDX-License-Identifier: MIT
// From shadcn/ui (https://ui.shadcn.com), Copyright (c) 2023 shadcn, MIT License.
// Pulled with `shadcn@4.21.0 add scroll-area`; see packages/dashboard/README.md for what was changed.

import * as React from "react"
import { cn } from "@/lib/utils"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

// Pome: `viewportRef` and `onViewportScroll` added so the tape can follow its
// newest row the way a log does, and stop following when the reader scrolls up.
function ScrollArea({
  className,
  children,
  viewportRef,
  onViewportScroll,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  viewportRef?: React.Ref<HTMLDivElement>
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        onScroll={onViewportScroll}
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none",
        orientation === "vertical" &&
          "h-full w-2.5 border-l border-l-transparent",
        orientation === "horizontal" &&
          "h-2.5 flex-col border-t border-t-transparent",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
