// SPDX-License-Identifier: Apache-2.0
//
// Open a URL in whatever browser this machine calls default.
//
// Lifted out of `login.ts` so `pome twin start --open` can reach it without
// pulling the login flow — and with it the credentials store and the hosted
// client — onto the startup path of a command that talks to nothing but
// localhost.
//
// Never rejects: a machine with no browser (a container, a CI runner, an ssh
// session) is a normal place to run `pome twin start`, and the URL has already
// been printed by the time this is called. It resolves when the launcher exits,
// which for `xdg-open` can be when the browser does — so a caller with work of
// its own starts it and does not await it.
import { execFile } from "node:child_process";

export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "powershell.exe"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["-NoProfile", "-Command", "Start-Process", url] : [url];

  await new Promise<void>((resolve) => {
    const failed = () => {
      console.error("Could not open a browser automatically — copy the URL above into a browser.");
      resolve();
    };
    try {
      execFile(command, args, (error) => (error ? failed() : resolve()));
    } catch {
      // `spawn` reports a missing command through the callback but throws the
      // errors it does not expect (EPERM in a sandbox), and an unawaited
      // rejection would take the twins down with it.
      failed();
    }
  });
}
