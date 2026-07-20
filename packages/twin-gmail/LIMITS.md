# Domain limits

Pinned limits enforced by seed, MIME, search, REST list/batch, and MCP pageSize.

| Limit | Value | Notes |
| --- | --- | --- |
| Raw MIME bytes (accept) | `36700160` | Checked before parse and after base64url decode |
| Decoded MIME bytes | `36700160` | Canonical raw upper bound |
| Header count / header bytes | `1000` / `262144` | Folded headers count after unfolding |
| MIME parts / nesting depth | `500` / `20` | Multipart boundaries fail loudly |
| Recipients (To+Cc+Bcc) | `500` per field in seeds | Send delivery is deduplicated by normalized address |
| Attachment count / filename bytes / attachment bytes | `100` / `512` / bounded by raw | Recording projects to `{sha256,size}` |
| `messages.send` / insert media `maxSize` (discovery) | `36700160` | From discovery; twin may lower |
| `messages.insert` / `import` media `maxSize` (discovery) | `157286400` | From discovery; twin may lower |
| Draft create/update media `maxSize` (discovery) | `36700160` | From discovery; twin may lower |
| Search query bytes / tokens / nesting / branches | `4096` / `256` / `20` / `256` | Shared AST for domain + filters |
| In-memory search mailbox messages | `10000` | Intentional bound: hydrate + JS predicate; **loud fail** above budget. Parameterized SQL compile of the AST is deferred |
| Colored-star `has:*-star` | unsupported | Loud reject; use `is:starred` (system `STARRED` only) |
| Labels per mailbox / per message | `5000` / `100` in seeds | |
| Filters per mailbox | `1000` in seeds | `action.forward` → 501 (no forwarding delivery) |
| Batch modify/delete ID count | `1000` | Enforced on `batchModify` / `batchDelete` |
| List `maxResults` | default `100`, max `500` | REST messages/threads/drafts/history |
| History page size | default `100`, max `500` | Same `maxResults` cap as other lists |
| MCP `pageSize` | default `20`, max `50` | `search_threads` / `list_drafts` / `list_labels` |
| State export message bodies | always digested | `/_pome/state` never includes plaintext text/html/headers/snippet (sha256 digests only); collections capped at `2000` rows; **history** keeps the newest 2000 when truncated (messages/attachments/labels keep oldest-first); body-omission flag set when mailbox exceeds `500` messages |
| SQLite bind parameters | parameterized only | Query text is never interpolated |
| Packaged boot | ≤ 3s | Contract gate (later) |

## Page tokens

Opaque page tokens are HMAC-signed and bound to mailbox email, route, normalized
query/filter, and the mailbox history high-water mark. The signing key resolves as:

1. `POME_GMAIL_PAGE_TOKEN_SECRET` when set
2. else a key derived from `TWIN_AUTH_SECRET`
3. else a per-process ephemeral secret

There is no forgeable public default string. Cross-mailbox, cross-query, and stale
snapshot tokens fail with `invalidArgument`.

See `performanceBudgets` in [`fidelity.inventory.json`](fidelity.inventory.json).
