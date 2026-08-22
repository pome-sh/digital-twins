// SPDX-License-Identifier: Apache-2.0
//
// The F-1152 incident in miniature, for scripts/probe-example-tools.test.mjs.
//
// `comment_on_issue` wraps `add_issue_comment` at a number that has no issue
// behind it — this fixture's seed carries `issues: []`, exactly as all four of
// the real subjects did — so the twin answers `404 Issue not found` on every
// call. And `twin()` swallows it and hands the caller `{ok: false, status}`,
// copying `agent-examples/merge-agent`'s `gh()`, so a gate that watched for a thrown
// error would see nothing at all.
export function buildTools(config) {
  const twin = async (tool, args) => {
    const res = await fetch(`${config.mcpUrl.replace(/\/$/, "")}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ tool, arguments: args }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: text };
    return text ? JSON.parse(text) : null;
  };

  return {
    comment_on_issue: {
      execute: ({ owner, repo, issue_number, body }) =>
        twin("add_issue_comment", { owner, repo, issue_number, body }),
    },
  };
}
