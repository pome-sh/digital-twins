// SPDX-License-Identifier: Apache-2.0
// F-1460 — the base64 rule for `PUT /repos/:owner/:repo/contents/*`.
//
// ⚠️ THIS BELONGS TO THE REST DOOR AND NOWHERE ELSE. `routes.ts` is the only
// caller, deliberately. The domain (`domain/git.ts`) serves BOTH doors off one
// `createOrUpdateFile`, and GitHub's two doors take `content` differently:
//
//   REST  `PUT /contents/*`        — base64. Documented as "using Base64
//                                    encoding"; there is no other encoding and
//                                    no switch to select one.
//   MCP   `create_or_update_file`  — PLAIN TEXT. GitHub's own MCP server
//         `push_files`               base64-encodes it for you before it calls
//                                    the REST API above, and its tool schema
//                                    tells the model so in as many words.
//
// So the decode has to happen at the REST boundary, on the way IN, and the
// domain has to keep receiving decoded content from both doors. Pushing it down
// one level — into `createOrUpdateFile` — would make the MCP door reject the
// plain text GitHub's MCP door requires, which is the wider divergence.
//
// See `test/contents-base64.test.ts` for the live measurement this encodes.

import { TwinError } from "./errors.js";

/**
 * GitHub validates STRUCTURE, not meaning: the base64 alphabet plus a padded
 * length. `test` is well formed, so GitHub accepts it and writes three junk
 * bytes; `abcde` is not, so it is refused. Whitespace is tolerated anywhere,
 * which is what makes a MIME-wrapped body work.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Real GitHub's answer, verbatim — 422, this message, NO `errors` array (unlike
 * the twin's `validationFailed`, which emits "Validation Failed" and one), and
 * the operation-specific documentation url rather than the generic one.
 */
function invalidBase64(): never {
  throw new TwinError(
    "content is not valid Base64",
    422,
    undefined,
    "https://docs.github.com/rest/repos/contents#create-or-update-file-contents"
  );
}

/**
 * Decode a REST `content` body field the way real GitHub decodes it, or refuse
 * it the way real GitHub refuses it.
 *
 * Returns a `Buffer` rather than a string ON PURPOSE, even though the caller
 * immediately narrows it to UTF-8 text: `content` is BYTES on this surface, and
 * making the lossy step explicit at the call site is the point. `files.content`
 * is a TEXT column and `encodeContent` re-encodes it as UTF-8 on the way out
 * (`util.ts`), so this twin stores text end to end and a caller who writes a PNG
 * gets replacement characters back. That is a REAL divergence from GitHub, and
 * a NEW one — before F-1460 `content` was never base64, so no caller could
 * express non-UTF-8 bytes at all and the gap was unreachable. It is recorded as
 * divergence 29 rather than hidden here, because closing it means changing the
 * storage convention for every surface that reads file content (diffs, search,
 * blobs), which is not this change.
 */
export function decodeRestContent(content: string): Buffer {
  const stripped = content.replace(/\s+/g, "");
  if (!BASE64.test(stripped)) invalidBase64();
  if (stripped.length % 4 !== 0) invalidBase64();

  // Node's decoder is lenient where GitHub is strict, so the guards above are
  // the contract and this call is only the arithmetic. Re-encoding the result
  // and comparing would be stricter than GitHub, which accepts non-canonical
  // padding bits that a round-trip comparison rejects.
  return Buffer.from(stripped, "base64");
}
