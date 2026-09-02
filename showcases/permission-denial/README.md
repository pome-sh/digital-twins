<!-- SPDX-License-Identifier: Apache-2.0 -->

# Permission denial

Run the automated check from the repository root:

```bash
./showcases/permission-denial/verify.sh
```

One running GitHub digital twin refuses a merge from `ci-bot` without changing state. It then accepts the same request from `pome-agent`. The script ends with `PASS` when every assertion holds.

See the [showcase prerequisites](../README.md) before running it. No login or model API key is required.

## Proof Checkpoints

The verifier checks these results against the same running twin:

| Check | Expected result |
| --- | --- |
| Seeded pull request | `open`, `merged: false` |
| `ci-bot` read | HTTP `200` |
| `ci-bot` merge | HTTP `403` with GitHub's push-access message |
| Exported state before and after refusal | Byte-identical |
| Refusal on the tape | `state_mutation: false`, `state_delta: null`, `fidelity: semantic` |
| `pome-agent` merge | HTTP `200` |
| Merged pull request | `closed`, `merged: true` |
| File on `main` | `export const ORDER_TIMEOUT_MS = 30000;` |
| Allowed merge on the tape | A mutation with a state delta |

The tape must distinguish the two outcomes:

```text
403  false  null
200  true   object
```

The verifier also confirms that bearer values are redacted, a missing pull request returns a modeled `404`, and an unmodeled route returns `501` with `fidelity: unsupported`.

## Optional Manual Explanation

The twin starts from a seed containing pull request `acme/api#1`. Its printed bearer identifies `pome-agent`, which has push access. The verification script uses the twin's persisted secret to mint a `ci-bot` bearer that can read the pull request but cannot merge it. Keeping token creation in the script avoids requiring readers to implement JWT signing by hand.

The script snapshots `/_pome/state`, sends `PUT /repos/acme/api/pulls/1/merge` as `ci-bot`, compares the state snapshots, and inspects `/_pome/events`. Without restarting or reconfiguring the twin, it repeats the merge as `pome-agent` and checks the merged file. Its twin process uses:

```bash
GITHUB_CLONE_DB=.pome/github.db \
  npx -y @pome-sh/cli@latest twin start github --port "$PORT" --seed seed.json
```

Use `verify.sh` as the runnable primary path because it owns `$PORT`, `seed.json`, both bearer tokens, cleanup, and every proof assertion.
