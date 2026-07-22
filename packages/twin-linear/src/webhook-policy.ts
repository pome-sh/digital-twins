// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * SSRF guard for outbound webhook delivery.
 *
 * Default-deny: loopback, link-local (incl. the 169.254.169.254 cloud metadata
 * endpoint), private, unique-local, and other non-public destinations are
 * blocked. Hostnames are validated against their *resolved* addresses at
 * dispatch time so a public name that resolves to an internal IP is also caught.
 *
 * Loopback/private delivery (trusted lab callbacks, local dev) is opt-in via the
 * LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS environment flag — an operator/deployment
 * trust decision, never something the agent under test can set.
 */
export function privateWebhooksAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.LINEAR_TWIN_ALLOW_PRIVATE_WEBHOOKS;
  return value === "1" || value === "true";
}

/** True when an IP literal is a loopback/private/link-local/reserved address. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip.toLowerCase());
  // Not a valid literal — treat as blocked; callers only pass real addresses.
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT (100.64/10)
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // multicast + reserved + 255.255.255.255 broadcast
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  if (ip === "::" || ip === "::1") return true; // unspecified / loopback
  // IPv4-mapped/embedded (e.g. ::ffff:169.254.169.254) — classify the v4 tail.
  if (ip.includes(".")) {
    const v4 = ip.slice(ip.lastIndexOf(":") + 1);
    if (isIP(v4) === 4) return isBlockedIpv4(v4);
  }
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (ip.startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

/**
 * Resolve a webhook URL's host and decide whether delivery must be refused.
 * Returns true when the destination is blocked under the default-deny policy.
 */
export async function webhookDestinationBlocked(
  url: string,
  opts: { allowPrivate?: boolean; resolve?: LookupFn } = {}
): Promise<boolean> {
  if (opts.allowPrivate ?? privateWebhooksAllowed()) return false;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true; // unparseable — refuse
  }
  // URL.hostname keeps brackets around IPv6 literals.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (isIP(host)) return isBlockedIp(host);

  // Hostname: validate every resolved address (public name → internal IP is SSRF too).
  const resolver = opts.resolve ?? ((h: string) => lookup(h, { all: true }));
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolver(host);
  } catch {
    // Unresolvable host is not an SSRF target; let the fetch fail normally.
    return false;
  }
  if (addresses.length === 0) return false;
  return addresses.some((entry) => isBlockedIp(entry.address));
}
