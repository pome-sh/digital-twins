# GitHub Twin Fidelity Matrix

Last verified: 2026-08-08

| Surface | Heat | Tier | Contract |
| --- | --- | --- | --- |
| `GET /repos/:owner/:repo` | hot | semantic | Repository shape and 404 errors match the supported REST subset. |
| `POST /user/repos` | hot | semantic | Creates a repository with deterministic README and main branch. |
| `POST /orgs/:owner/repos` | hot | semantic | Org-owned repository creation; same semantics as `/user/repos`. |
| `POST /repos/:owner/:repo/forks` | hot | semantic | Copies repository, files, and commits into the fork owner or organization. |
| `GET /repos/:owner/:repo/issues` | hot | semantic | State, labels, assignees, pagination, and filters are clone-backed. |
| `POST /repos/:owner/:repo/issues` | hot | semantic | Creates persistent issues with GitHub-shaped labels and assignees. |
| `GET /repos/:owner/:repo/issues/:number` | hot | semantic | Reads persisted issue state and returns GitHub-style 404. |
| `PATCH /repos/:owner/:repo/issues/:number` | hot | semantic | Mutates title/body/state/labels/assignees and records state mutation. |
| `GET /repos/:owner/:repo/issues/:number/comments` | hot | semantic | Lists persisted conversation comments with pagination. `:number` may name an ISSUE or a PULL REQUEST, as on real GitHub. |
| `POST /repos/:owner/:repo/issues/:number/comments` | hot | semantic | Creates persistent conversation comments. `:number` may name an ISSUE or a PULL REQUEST — this is how a PR's conversation is commented on; `pulls/:number/comments` is the inline review-comment surface instead. |
| `PATCH /repos/:owner/:repo/issues/comments/:comment_id` | hot | semantic | Updates issue comment body and `updated_at`. One id space across both target kinds, so this addresses a PR's comment too. |
| `DELETE /repos/:owner/:repo/issues/comments/:comment_id` | hot | semantic | Deletes issue comment; 404 for unknown id. |
| `GET /repos/:owner/:repo/labels` | hot | semantic | Lists repository labels with deterministic local IDs. |
| `POST /repos/:owner/:repo/labels` | warm | semantic | Creates labels; color validation is intentionally permissive. |
| `GET /repos/:owner/:repo/issues/:number/labels` | hot | semantic | Returns the current issue label set. |
| `POST /repos/:owner/:repo/issues/:number/labels` | hot | semantic | Missing labels return GitHub-shaped 422s. |
| `DELETE /repos/:owner/:repo/issues/:number/labels/:name` | hot | semantic | 404 when removing a label the issue does not carry. |
| `POST /repos/:owner/:repo/issues/:number/assignees` | hot | semantic | Requires seeded collaborators. |
| `GET /repos/:owner/:repo/collaborators` | hot | semantic | Lists seeded collaborators as GitHub user objects. |
| `GET /repos/:owner/:repo/collaborators/:username` | hot | semantic | Returns `204` for present collaborators and `404` for absent users. |
| `PUT /repos/:owner/:repo/collaborators/:username` | warm | semantic | Creates invitation (201) for new users; returns 204 for existing collaborators. |
| `GET /repos/:owner/:repo/pulls` | hot | semantic | Lists pull requests with supported state and pagination filters. Carries `stack`, derived from the base chain (divergence #11). |
| `POST /repos/:owner/:repo/pulls` | hot | semantic | Creates clone-backed PRs from existing branches. |
| `PATCH /repos/:owner/:repo/pulls/:number` | hot | semantic | Title/body/state/base mutations; recomputes PR files on base change. |
| `GET /repos/:owner/:repo/pulls/:number` | hot | semantic | PR detail. Carries `stack`, derived from the base chain (divergence #11). |
| `GET /repos/:owner/:repo/pulls/:number/files` | hot | semantic | Per-file adds/deletes/changes for the PR range. |
| `GET /repos/:owner/:repo/pulls/:number/reviews` | hot | semantic | Persisted reviews, oldest first. |
| `POST /repos/:owner/:repo/pulls/:number/reviews` | hot | semantic | Creates APPROVE / REQUEST_CHANGES / COMMENT reviews. |
| `GET /repos/:owner/:repo/pulls/:number/comments` | hot | semantic | Inline review comments. The PR's conversation comments are `issues/:number/comments` instead. |
| `GET /repos/:owner/:repo/pulls/:number/status` | hot | semantic | Combined status for the PR head SHA. |
| `PUT /repos/:owner/:repo/pulls/:number/merge` | hot | semantic | Merges and closes; 403 without push access on the repository. |
| `PUT /repos/:owner/:repo/pulls/:number/update-branch` | hot | semantic | Semantic merge of base into head. |
| `GET /repos/:owner/:repo/pulls/:number/commits` | hot | semantic | Oldest-first commit walk between base_sha..head_sha. |
| `GET /repos/:owner/:repo/pulls/:number/diff` | hot | shape | Unified-diff-shaped envelope; patches are simplified placeholders. Hot gap, deferred post-M5. |
| `POST /repos/:owner/:repo/pulls/:number/comments` | hot | semantic | Creates inline review comments; 422 if path is not in the PR. |
| `POST /repos/:owner/:repo/pulls/:number/comments/:comment_id/replies` | hot | semantic | Reply inherits path/line/side/commit_sha from parent. |
| `GET /repos/:owner/:repo/branches` | hot | semantic | Branch list with pagination. |
| `GET /repos/:owner/:repo/branches/:branch` | hot | semantic | Single branch with commit pointer. |
| `DELETE /repos/:owner/:repo/git/refs/heads/:branch` | hot | semantic | 422 on default branch or branch backing an open PR. |
| `POST /repos/:owner/:repo/git/refs` | hot | semantic | Creates a branch ref from an existing SHA or branch head. |
| `GET /repos/:owner/:repo/contents/*` (READ) | hot | semantic | Existing GET preserved. GitHub's `/contents/{path}` accepts an empty path — the repository-root listing — which hono cannot match with a wildcard, so this one surface is mounted as two router patterns. |
| `PUT /repos/:owner/:repo/contents/*` (CREATE/UPDATE) | hot | semantic | Existing PUT preserved. |
| `DELETE /repos/:owner/:repo/contents/*` | hot | semantic | Requires `sha`; advances branch head with deletion commit. |
| `GET /repos/:owner/:repo/commits` | hot | semantic | Branch-scoped ancestry walk with pagination. |
| `GET /repos/:owner/:repo/commits/:ref` | hot | semantic | Single commit with stats and file_versions. |
| `GET /repos/:owner/:repo/compare/:basehead` | warm | shape | First-parent ancestry; status=ahead/behind/identical/diverged. |
| `POST /repos/:owner/:repo/statuses/:sha` | hot | semantic | Append-only commit statuses with 404 if SHA not in repo. |
| `GET /repos/:owner/:repo/commits/:ref/status` | hot | semantic | Combined-status rule applied across recorded statuses. |
| `POST /repos/:owner/:repo/check-runs` | hot | semantic | 422 if `status=completed` without `conclusion`. |
| `GET /repos/:owner/:repo/commits/:ref/check-runs` | hot | semantic | Most-recent-started-first; pagination. |
| `GET /repos/:owner/:repo/milestones` | warm | semantic | State filter + pagination. |
| `POST /repos/:owner/:repo/milestones` | warm | semantic | 422 on duplicate title. |
| `PATCH /repos/:owner/:repo/milestones/:number` | warm | semantic | Closes/reopens with `closed_at` bookkeeping. |
| `DELETE /repos/:owner/:repo/milestones/:number` | warm | semantic | 404 on unknown milestone. |
| `GET /repos/:owner/:repo/tags` | hot | semantic | Tag → commit SHA. |
| `GET /repos/:owner/:repo/releases` | hot | semantic | Newest-first; includes drafts. |
| `GET /repos/:owner/:repo/releases/latest` | hot | semantic | Skips drafts and prereleases. |
| `GET /repos/:owner/:repo/releases/tags/:tag` | hot | semantic | Release lookup by tag name; 404 for unknown tag. |
| `POST /repos/:owner/:repo/releases` | warm | semantic | Auto-creates tag from `target_commitish` if missing. |
| `GET /user` | hot | semantic | Returns JWT-claimed `login`. |
| `GET /search/repositories` | hot | semantic | Searches clone state. Result-set counts reflect the local seed, not GitHub's global index (divergence #18). |
| `GET /search/code` | hot | semantic | Searches clone state (divergence #18). Takes `q` only; `repo:`/`user:`/`org:` are parsed out of it, other qualifiers are not (divergence #1). |
| `GET /search/commits` | hot | semantic | Searches clone state (divergence #18). Takes `q` only; `repo:`/`user:`/`org:` are parsed out of it (divergence #1). |
| `GET /search/issues` | hot | semantic | Searches clone state (divergence #18). Takes `q` only; `repo:`/`user:`/`org:`/`state:` are parsed out of it and `?state=` is ignored (divergence #1). No `state=open` default. |
| `GET /search/users` | hot | semantic | Searches clone state; `type` is not modelled (divergence #15, #18). |
| `POST /mcp/call` and `POST /mcp/tools/:name` | unclassified | semantic | MCP tools mutate the same state as REST routes. Engine introspection — outside the rubric's inventory scope; rows retained until the post-launch-gate surface-count reconcile. |
| `GET /repos/:owner/:repo/actions/*` | cold | unsupported | Named cold: loud 501, test-backed (`m5-hot-gaps.test.ts`); top post-M5 promotion candidate. |
| `GET /repos/:owner/:repo/git/trees/:sha` | cold | unsupported | Named cold: git plumbing stays loud 501, test-backed. |
| `GET /orgs/:org/teams` | cold | unsupported | Named cold: single-actor sandbox; vendor default-on disagreement recorded. |
| `GET /repos/:owner/:repo/issues/:number/sub_issues` | cold | unsupported | Named cold: loud 501, test-backed. |
| `GET /orgs/:org/issue-types` | cold | unsupported | Named cold: loud 501, test-backed. |
| Any unsupported path | cold | unsupported | Returns loud `501` with supported surfaces instead of empty `200` or random `500`. |
