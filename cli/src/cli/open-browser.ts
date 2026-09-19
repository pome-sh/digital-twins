// SPDX-License-Identifier: Apache-2.0
//
// Open a URL in whatever browser this machine calls default.
//
// Lifted out of `login.ts` so `pome twin start --open` can reach it without
// pulling the login flow — and with it the credentials store and the hosted
// client — onto the startup path of a command that talks to nothing but
// localhost.
//
// Never throws and never blocks the caller's own work: a machine with no
// browser (a container, a CI runner, an ssh session) is a normal place to run
// `pome twin start`, and the URL has already been printed by the time this is
// called.
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
    execFile(command, args, (error) => {
      if (error) {
        console.error(
          "Could not open a browser automatically — copy the URL above into a browser.",
        );
      }
      resolve();
    });
  });
}
