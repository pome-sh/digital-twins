---
"@pome-sh/cli": patch
---

`pome register agent` now sends the manifest's `twins` to `POST /v1/agents`, so the cloud agent's enabled services match the manifest instead of falling back to the server's `github` default. Previously a manifest like `twins: ["gmail"]` was ignored and the first `pome run` errored with `Requested twins are not enabled`. Any `--twins` flag is unioned with the manifest's twins (the server still merges additively).
