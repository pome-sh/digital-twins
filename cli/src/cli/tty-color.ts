// SPDX-License-Identifier: Apache-2.0
/** Color wraps only when stdout is a TTY and `NO_COLOR` is unset. */

export function useColor(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
}

export function dim(s: string): string {
  return useColor() ? `\x1b[2m${s}\x1b[0m` : s;
}

export function bold(s: string): string {
  return useColor() ? `\x1b[1m${s}\x1b[0m` : s;
}
