// SPDX-License-Identifier: Apache-2.0
//
// Which port each twin `pome twin start` boots listens on. One twin keeps the
// CONTRACT.md rule (`--port`, else `$PORT`, else the twin's default); several
// twins spread out from their defaults onto free ports (F-1836).

import { createServer } from "node:net";
import { defaultPortFor, type TwinName } from "./registry.js";

/** Can 127.0.0.1:port be bound right now? A probe bind, released at once. */
export async function isLoopbackPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/**
 * One port per twin, in argument order.
 *
 * A single twin keeps the old rule to the byte: `--port`, else `$PORT`, else
 * the twin's own default — and a busy port is a loud bind error, never a
 * silent move. Several twins cannot all sit on 3333 (github, slack and stripe
 * default to it), so each takes its default port and moves up to the next
 * free one when that is taken, on this host or by an earlier twin in the same
 * command. With `--port`, the first twin takes exactly that port and the
 * rest count upward from it, so `--port 4000` reads as "from 4000".
 */
export async function chooseStandalonePorts(
  twins: readonly TwinName[],
  portOption: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  isFree: (port: number) => Promise<boolean> = isLoopbackPortFree,
): Promise<number[]> {
  const parse = (raw: string): number => {
    const port = Number(raw);
    // Port 0 (ephemeral) is rejected: every printed URL and the status-file
    // token would name a port nobody can discover from outside the process.
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`pome twin start: invalid --port "${raw}"`);
    }
    return port;
  };
  if (twins.length === 1) return [parse(portOption ?? defaultPortFor(twins[0]!, env))];

  const chosen: number[] = [];
  for (const [index, twin] of twins.entries()) {
    if (index === 0 && portOption !== undefined) {
      chosen.push(parse(portOption));
      continue;
    }
    const start = portOption !== undefined ? chosen[index - 1]! + 1 : parse(defaultPortFor(twin, env));
    let candidate = start;
    while (chosen.includes(candidate) || !(await isFree(candidate))) {
      candidate += 1;
      if (candidate > 65535 || candidate - start > 200) {
        throw new Error(
          `pome twin start: no free port for the ${twin} twin within 200 of ${start} — pass --port <port>.`,
        );
      }
    }
    chosen.push(candidate);
  }
  return chosen;
}
