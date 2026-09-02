<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local showcases

These walkthroughs demonstrate one property of a local digital twin.
They use `pome twin start` and direct HTTP requests.

## Prerequisites

- Node.js 24 or later
- npm and `npx`
- Bash, `curl`, `jq`, and `cmp`

You do not need a Pome login or an API key.

## Walkthroughs

| Walkthrough | Demonstration |
| --- | --- |
| [`cross-call-state`](./cross-call-state/) | One process retains writes. A second process does not receive them. |
| [`permission-denial`](./permission-denial/) | A refused write appears on the tape and does not change state. |

Each directory leads with an automated check and includes a concise manual explanation. Run the scripts from the repository root:

```bash
./showcases/cross-call-state/verify.sh
./showcases/permission-denial/verify.sh
```

Each script creates temporary files, starts its required twins, and removes the files on exit. A failed check produces a nonzero exit status.
