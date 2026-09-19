// SPDX-License-Identifier: Apache-2.0
//
// The first screen a newcomer sees, and the one that has to teach the next step
// by itself — the Done-When says "without reading any docs".
//
// It offers the same three clients the `twin start` banner does, because a page
// that knew only `.mcp.json` was a weaker door than the terminal beside it. Two
// of the three carry no token and need the export line first; Claude Code's
// one command carries it and needs nothing else. The tabs keep each client's
// steps to exactly what that client needs.
import { useState, type ReactNode } from "react";
import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react";
import type { TwinSnapshot } from "@/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock, CodeWindow, CopyButton } from "./CodeWindow";
import { World } from "./World";

export function Empty({ twin }: { twin: TwinSnapshot }) {
  return (
    <section className="mx-auto w-full max-w-[1320px] px-4 pb-10 sm:px-6">
      <div className="px-2 pt-3 pb-7">
        <h1 className="font-serif text-[40px] leading-[1.1] font-normal tracking-[-1px] text-ink">
          Nothing recorded yet.
        </h1>
        <p className="mt-3 max-w-[62ch] text-[17px] leading-relaxed text-body">
          Connect an agent and ask it for something. Every request it makes will land here, in order,
          with what it changed.
        </p>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <Connect twin={twin} />
        <World twin={twin} seeded />
      </div>
    </section>
  );
}

const trigger =
  "h-9 flex-none rounded-none px-1 pb-2 text-sm font-medium text-muted-foreground after:bg-moss data-[state=active]:text-ink";

function Connect({ twin }: { twin: TwinSnapshot }) {
  const [shown, setShown] = useState(false);
  const c = twin.connect;

  const reveal = (
    <Button
      size="xs"
      variant="ghost"
      className="text-on-dark-soft hover:bg-dark-elevated hover:text-on-dark"
      onClick={() => setShown(!shown)}
    >
      {shown ? <EyeSlashIcon /> : <EyeIcon />}
      {shown ? "Hide token" : "Show token"}
    </Button>
  );
  const exportStep = (
    <Step n={1} text="Export the token in the shell your agent runs in.">
      <CodeWindow title="shell" actions={<>{reveal}<CopyButton text={c.exportLine} /></>}>
        <CodeBlock>{shown ? c.exportLine : c.exportLineMasked}</CodeBlock>
      </CodeWindow>
    </Step>
  );

  return (
    <Card className="gap-5 px-6 py-5">
      <div>
        <h2 className="font-serif text-xl tracking-[-0.3px] text-ink">Connect your agent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick the client it runs in. Each one points it at this twin over MCP.
        </p>
      </div>

      <Tabs defaultValue="claude" className="gap-5">
        <TabsList variant="line" className="h-auto gap-6 border-b border-border p-0">
          <TabsTrigger value="claude" className={trigger}>
            Claude Code
          </TabsTrigger>
          <TabsTrigger value="mcp" className={trigger}>
            <span className="font-mono">.mcp.json</span>
          </TabsTrigger>
          <TabsTrigger value="codex" className={trigger}>
            Codex
          </TabsTrigger>
        </TabsList>

        <TabsContent value="claude" className="flex flex-col gap-4">
          <Step text="Run this once. It carries the token, so there is nothing else to set.">
            <CodeWindow title="terminal" actions={<>{reveal}<CopyButton text={c.claudeCode} /></>}>
              <CodeBlock>{shown ? c.claudeCode : c.claudeCodeMasked}</CodeBlock>
            </CodeWindow>
          </Step>
        </TabsContent>

        <TabsContent value="mcp" className="flex flex-col gap-5">
          {exportStep}
          <Step n={2} text="Add this to .mcp.json in the repo. No token in it — it reads the one you exported.">
            <CodeWindow title=".mcp.json" actions={<CopyButton text={c.mcpJson} />}>
              <CodeBlock>{c.mcpJson}</CodeBlock>
            </CodeWindow>
          </Step>
        </TabsContent>

        <TabsContent value="codex" className="flex flex-col gap-5">
          {exportStep}
          <Step n={2} text="Append this to ~/.codex/config.toml. It names the variable, never the value.">
            <CodeWindow title="config.toml" actions={<CopyButton text={c.codexToml} />}>
              <CodeBlock>{c.codexToml}</CodeBlock>
            </CodeWindow>
          </Step>
        </TabsContent>
      </Tabs>

      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Tokens are masked so a photograph of this page never carries one. The terminal that started
        the twin printed it in full.
      </p>
    </Card>
  );
}

/** The design system's numbered step: "a display-serif moss numeral beside the step". */
function Step(props: { n?: number; text: string; children: ReactNode }) {
  // A lone step gets no numeral and no gutter for one: a "1" with nothing after
  // it is a list of one, and an empty gutter is an indent that means nothing.
  if (props.n === undefined) {
    return (
      <div className="flex flex-col gap-2.5">
        <p className="text-sm leading-5 text-body">{props.text}</p>
        {props.children}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2.5">
      <span className="w-4 font-serif text-xl leading-5 text-moss">{props.n}</span>
      <p className="text-sm leading-5 text-body">{props.text}</p>
      <div className="col-start-2">{props.children}</div>
    </div>
  );
}
