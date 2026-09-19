// SPDX-License-Identifier: Apache-2.0
//
// The page (F-1850). One job: someone who has never used Pome opens this while
// an agent is working and says out loud which write did not land.
//
// The twins are Radix tabs, so the tab strip and the panel under it are wired
// for a keyboard and a screen reader by the primitive — one tab stop, arrows
// between twins, `aria-controls` between tab and panel — rather than by hand.
import { useState } from "react";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSnapshot } from "@/useSnapshot";
import { Empty } from "./Empty";
import { Live } from "./Live";
import { Nav } from "./Nav";

export function App() {
  const { twins, ready, gone } = useSnapshot();
  const [active, setActive] = useState<string | null>(null);

  if (!ready || twins.length === 0) return <div className="min-h-dvh" aria-busy="true" />;
  const current = twins.find((twin) => twin.name === active) ?? twins[0]!;

  // Two ways a session ends, and they read the same: the twin stopped answering,
  // or `twin start` went away and took this server with it. `gone` is the
  // second — the last snapshot still says `reachable`, because it was, right up
  // until the process exited.
  const stoppedFor = (reachable: boolean) => gone || !reachable;

  return (
    <TooltipProvider delayDuration={500}>
      <Tabs
        value={current.name}
        onValueChange={setActive}
        className="min-h-dvh gap-0 lg:h-dvh lg:min-h-0"
      >
        <Nav twins={twins} current={current} stopped={stoppedFor(current.reachable)} />
        {twins.map((twin) => (
          <TabsContent key={twin.name} value={twin.name} className="flex flex-col lg:min-h-0">
            {twin.summary.requests === 0 ? (
              <Empty twin={twin} />
            ) : (
              <Live twin={twin} stopped={stoppedFor(twin.reachable)} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </TooltipProvider>
  );
}
