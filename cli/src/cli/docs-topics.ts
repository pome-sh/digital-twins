// SPDX-License-Identifier: Apache-2.0
/**
 * Static index of public Mintlify pages on docs.pome.sh — avoids scraping HTML.
 * The authored docs live in the `pome` repo and publish through Mintlify; this
 * package keeps only topic metadata for URL navigation.
 */
export interface DocsTopic {
  id: string;
  title: string;
  /** Path on the docs site, e.g. /getting-started */
  path: string;
  keywords: string[];
}

export const DOCS_TOPICS: DocsTopic[] = [
  {
    id: "pome",
    title: "Pome",
    path: "/introduction",
    keywords: ["overview", "what is pome", "platform", "agents"],
  },
  {
    id: "getting-started",
    title: "Quickstart",
    path: "/getting-started",
    keywords: ["install", "quickstart", "setup", "begin"],
  },
  {
    id: "existing-agent",
    title: "Bring your own agent",
    path: "/existing-agent",
    keywords: [
      "existing agent",
      "own agent",
      "already have an agent",
      "bring your own",
      "register",
      "pome.json",
      "connect",
      // Migrated from the retired skills-setup topic (F-893): wiring your own
      // agent is now the "bring your own agent" path. ("pome-setup" / "setup"
      // already resolve to getting-started via its "setup" keyword.)
      "wire",
    ],
  },
  {
    id: "how-pome-works",
    title: "How Pome works",
    path: "/docs/how-pome-works",
    keywords: ["twins", "scenarios", "runs", "scoring", "artifacts", "loop"],
  },
  // F-889 dropped the Gen-1 /setup and /test-with-pome skill pages from the
  // docs nav; F-893 retired the CLI commands that pointed at them. The two
  // topic entries are gone, but their still-live keywords are MIGRATED onto the
  // surviving replacement topics so `pome docs <kw>` keeps routing:
  //   wire → existing-agent;  test-with-pome / pome-test → cli-run;
  //   eval → cli (the CLI reference index — no dedicated eval page exists).
  //   (setup / pome-setup / register / run scenarios / /setup all already
  //   resolve via existing substrings — see the tests.)
  {
    id: "dashboard",
    title: "Pome Dashboard",
    path: "/docs/dashboard",
    keywords: ["runs", "agents", "clones", "judge", "web"],
  },
  {
    id: "twins",
    title: "Twins overview",
    path: "/docs/twins/index",
    keywords: ["sandbox", "digital twin", "hosted"],
  },
  {
    id: "github",
    title: "GitHub twin",
    path: "/docs/twins/github",
    keywords: ["git", "repo", "issues", "mcp", "scenarios"],
  },
  {
    id: "stripe",
    title: "Stripe twin",
    path: "/docs/twins/stripe",
    keywords: ["payments", "x402", "refund", "payment intent", "stripe"],
  },
  {
    id: "slack",
    title: "Slack twin",
    path: "/docs/twins/slack",
    keywords: ["messaging", "channels", "workspace", "slack", "exfiltration"],
  },
  {
    id: "gmail",
    title: "Gmail twin",
    path: "/docs/twins/gmail",
    keywords: ["email", "inbox", "drafts", "labels", "gmail", "mcp"],
  },
  {
    id: "cli",
    title: "Command Line Interface",
    path: "/docs/cli",
    // "eval" migrated from the retired skills-test topic (F-893): there is no
    // dedicated `pome eval` docs page, and it is a distinct workflow from
    // `pome inspect`, so it routes to the CLI reference index that documents
    // every command rather than to a sibling command's page.
    keywords: ["commands", "flags", "pome run", "reference", "eval"],
  },
  {
    id: "cli-run",
    title: "pome run",
    path: "/docs/cli/run",
    keywords: [
      "run",
      "scenario",
      "agent",
      "flags",
      "artifacts",
      "default",
      "demo task",
      "run yours",
      // Migrated from the retired skills-test topic (F-893): running tasks is
      // how you test an agent with pome.
      "test-with-pome",
      "pome-test",
    ],
  },
  {
    id: "cli-session",
    title: "pome session",
    path: "/docs/cli/session",
    keywords: ["session", "hosted", "sandbox", "twin"],
  },
  {
    id: "cli-tasks",
    title: "pome tasks",
    // F-912 — the M4 docs door renamed the docs.pome.sh page from
    // /docs/cli/scenarios to /docs/cli/tasks (a redirect keeps the old URL
    // alive), so `path` now points at the new route. The "scenarios" keyword
    // stays so `pome docs scenarios` still resolves to this topic.
    path: "/docs/cli/tasks",
    keywords: ["tasks", "scenarios", "catalog", "copy", "library", "twin"],
  },
  {
    id: "cli-compile-seeds",
    title: "pome compile-seeds",
    path: "/docs/cli/compile-seeds",
    keywords: ["compile-seeds", "seed", "sidecar", "compiler", "anthropic"],
  },
  {
    id: "cli-inspect",
    title: "pome inspect",
    path: "/docs/cli/inspect",
    keywords: ["inspect", "score", "trace", "artifacts", "verdicts"],
  },
  {
    id: "cli-init",
    title: "pome init",
    path: "/docs/cli/init",
    keywords: ["init", "scaffold", "pome.json", "manifest", "project"],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    path: "/docs/troubleshooting",
    keywords: ["errors", "help", "fix", "debug"],
  },
  {
    id: "changelog",
    title: "Changelog",
    path: "/changelog",
    keywords: ["release", "version", "news"],
  },
];
