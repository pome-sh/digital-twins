// SPDX-License-Identifier: Apache-2.0
//
// A throwaway example for scripts/probe-example-tools.test.mjs (F-1152). Its
// tools all reach subjects the seed provides, so the gate must stay silent.
//
// Two shapes are deliberate. It calls the twin's MCP surface, which is where
// F-1125 stamps the twin ACTION on the tape even for a failed call, so the
// end-to-end test can assert the action name reaches the report. And `twin()`
// SWALLOWS a non-2xx and returns it as a value instead of throwing — copying
// `examples/merge-agent`'s `gh()` — so the fixture also exercises the path
// where the handler's return value proves nothing and only the wire counts.
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
    list_open_issues: {
      // `OPEN`, not `open` (F-1468): GitHub's MCP `list_issues` declares
      // `["OPEN","CLOSED"]` and the twin follows it. Its REST `GET /issues` is
      // the door that takes lowercase.
      execute: ({ owner, repo }) => twin("list_issues", { owner, repo, state: "OPEN" }),
    },
    comment_on_issue: {
      execute: ({ owner, repo, issue_number, body }) =>
        twin("add_issue_comment", { owner, repo, issue_number, body }),
    },
  };
}
