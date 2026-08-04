---
"@pome-sh/cli": patch
---

Re-pin the bundled `@pome-sh/*` packages to the packages-v31 batch: twin-github
0.9.0 (adds the `github.no-new-issues` declaration), sdk 0.11.1, shared-types
0.14.1, adapter 0.3.1, twin-gmail/linear/slack 0.3.3, twin-stripe 0.4.4. The CLI
bundles these, so `pome checks github` now lists 15 declarations instead of 14.
