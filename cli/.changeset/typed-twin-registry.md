---
"@pome-sh/cli": minor
---

Replace four parallel twin lists with one typed `TWIN_REGISTRY`.

Adding a twin is now a single registry entry (env prefix, port, seed, boot)
instead of editing switches across harness/start/adapter files, and each twin
loads through a lazy `import()` so a bundler can split them.
