// SPDX-License-Identifier: Apache-2.0
/**
 * Static index of public Mintlify pages on docs.pome.sh — avoids scraping HTML.
 * Every `path` must be a page docs.json actually serves: there are no redirects
 * from old doc URLs to lean on, so a stale path here prints a 404 to a user.
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
    path: "/quickstart/coding-agent",
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
      "wire",
    ],
  },
  {
    id: "how-pome-works",
    title: "How Pome works",
    path: "/docs/how-pome-works",
    keywords: ["twins", "scenarios", "runs", "scoring", "artifacts", "loop"],
  },
  {
    id: "dashboard",
    title: "Pome Dashboard",
    path: "/docs/dashboard",
    keywords: ["runs", "agents", "clones", "judge", "web"],
  },
  {
    id: "twins",
    title: "Twins overview",
    path: "/docs/twins/coverage",
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
    id: "linear",
    title: "Linear twin",
    path: "/docs/twins/linear",
    keywords: ["projects", "cycles", "linear"],
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
    // No dedicated `pome eval` page exists, and eval is a distinct workflow
    // from `pome inspect`, so "eval" routes to the reference index.
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
    ],
  },
  {
    id: "cli-sandbox",
    title: "pome sandbox",
    path: "/docs/cli/sandbox",
    keywords: ["sandbox", "hosted", "twin"],
  },
  {
    id: "cli-tasks",
    title: "pome tasks",
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
];
