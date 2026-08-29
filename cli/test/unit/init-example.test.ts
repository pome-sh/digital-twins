import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../../src/cli/main.js";
import { CATALOG_EXAMPLES } from "../../src/cli/example-catalog.js";
import {
  EXAMPLE_REPO,
  ExampleScaffoldError,
  exampleIds,
  fetchExampleFiles,
  findExample,
  firstTaskFile,
  rawUrlFor,
  resolveExampleRef,
  scaffoldExample,
  scaffoldSummary,
  unknownExampleMessage,
} from "../../src/cli/init-example.js";

const REPO_ROOT = resolve(__dirname, "../../..");
const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempProject(prefix = "pome-init-example-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  process.chdir(dir);
  return dir;
}

/** A fetch that answers every URL with the path it was asked for. */
function fakeFetch(overrides: Record<string, number> = {}) {
  const seen: string[] = [];
  const impl = async (url: string) => {
    seen.push(url);
    const status = overrides[url] ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => new TextEncoder().encode(`contents of ${url}`).buffer as ArrayBuffer,
    };
  };
  return { impl, seen };
}

describe("the example catalog is derived from the directories", () => {
  // The whole point of the id mechanism: nobody restates the id set, so a
  // directory that disappears takes its id with it. Asserted against the real
  // tree rather than the generator, because the generator is what produced the
  // committed file and would agree with itself.
  it("holds exactly the example directories on disk, from both roots", () => {
    const onDisk = ["agent-examples", "integration-examples"].flatMap((root) =>
      readdirSync(join(REPO_ROOT, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => existsSync(join(REPO_ROOT, root, entry.name, "package.json")))
        .map((entry) => `${root}/${entry.name}`),
    );

    expect([...CATALOG_EXAMPLES.map((e) => e.rel)].sort()).toEqual([...onDisk].sort());
    expect(CATALOG_EXAMPLES.some((e) => e.root === "agent-examples")).toBe(true);
    expect(CATALOG_EXAMPLES.some((e) => e.root === "integration-examples")).toBe(true);
  });

  it("gives each entry the file list that directory actually tracks", () => {
    for (const example of CATALOG_EXAMPLES) {
      expect(example.files).toContain("package.json");
      expect(example.files).toContain("pome.json");
      for (const file of example.files) {
        expect(existsSync(join(REPO_ROOT, example.rel, file))).toBe(true);
      }
    }
  });

  it("carries the ids the docs will name post-#499, not the pre-split ones", () => {
    expect(exampleIds()).toContain("braintrust");
    expect(exampleIds()).toContain("langsmith");
    expect(exampleIds()).not.toContain("braintrust-eval");
    expect(exampleIds()).not.toContain("langsmith-eval");
    // The three URLs F-1738 measured as 404 are now these two ids.
    expect(exampleIds()).toContain("minimal-viktor");
    expect(exampleIds()).toContain("minimal-viktor-langgraph");
  });
});

describe("unknown ids", () => {
  it("lists every valid id rather than only saying no", () => {
    const message = unknownExampleMessage("minimal-victor");
    expect(message).toContain('Unknown example "minimal-victor"');
    for (const id of exampleIds()) expect(message).toContain(id);
  });

  it("exits 2 and prints the list through the command", async () => {
    await tempProject();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(["node", "pome", "init", "--example", "no-such-example"]);

    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain('Unknown example "no-such-example"');
    expect(printed).toContain("minimal-viktor");
    // Nothing was scaffolded, and no competing manifest was written.
    expect(existsSync("pome.json")).toBe(false);
  });
});

describe("fetching", () => {
  it("addresses raw.githubusercontent.com at the repo, ref and example path", () => {
    const example = findExample("minimal-viktor")!;
    expect(rawUrlFor(example, "src/index.ts", "main")).toBe(
      `https://raw.githubusercontent.com/${EXAMPLE_REPO}/main/agent-examples/minimal-viktor/src/index.ts`,
    );
  });

  it("prefers POME_EXAMPLE_REF, and falls back to main in a source-tree run", () => {
    expect(resolveExampleRef({ POME_EXAMPLE_REF: "my-branch" } as NodeJS.ProcessEnv)).toBe("my-branch");
    // No `PKG_GIT_SHA` define under vitest, so this is the contributor path.
    expect(resolveExampleRef({} as NodeJS.ProcessEnv)).toBe("main");
  });

  it("writes nothing when one file 404s mid-fetch", async () => {
    const dir = await tempProject();
    const example = findExample("gmail-retry-notify")!;
    const missing = rawUrlFor(example, example.files[2], "main");
    const { impl } = fakeFetch({ [missing]: 404 });

    await expect(
      scaffoldExample({ id: example.id, cwd: dir, ref: "main", fetchImpl: impl }),
    ).rejects.toBeInstanceOf(ExampleScaffoldError);

    // Fetch-then-write: a partial example that installs and fails somewhere
    // unrelated is worse than no example.
    expect(existsSync(join(dir, example.id))).toBe(false);
  });

  it("names the URL and the status when the repo and the catalog disagree", async () => {
    const dir = await tempProject();
    const example = findExample("gmail-retry-notify")!;
    const missing = rawUrlFor(example, example.files[0], "main");
    const { impl } = fakeFetch({ [missing]: 404 });

    await expect(
      scaffoldExample({ id: example.id, cwd: dir, ref: "main", fetchImpl: impl }),
    ).rejects.toThrow(/returned HTTP 404/);
  });

  it("turns a network failure into an instruction, not a stack trace", async () => {
    const example = findExample("merge-agent")!;
    const impl = async () => {
      throw new Error("getaddrinfo ENOTFOUND raw.githubusercontent.com");
    };
    await expect(fetchExampleFiles(example, "main", impl)).rejects.toThrow(
      /check your network or proxy and retry/,
    );
  });
});

describe("pome init --example <id>", () => {
  it("scaffolds every catalog file into ./<id> and prints the next steps", async () => {
    const dir = await tempProject();
    const example = findExample("gmail-retry-notify")!;
    const { impl, seen } = fakeFetch();
    vi.stubGlobal("fetch", impl);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await createProgram().parseAsync(["node", "pome", "init", "--example", "gmail-retry-notify"]);

    expect(process.exitCode ?? 0).toBe(0);
    for (const file of example.files) {
      expect(existsSync(join(dir, example.id, file))).toBe(true);
    }
    expect(seen).toHaveLength(example.files.length);
    expect(seen.every((url) => url.includes(`/${example.rel}/`))).toBe(true);

    // Subdirectories come along: `tasks/` and `src/` are not flattened.
    expect(readFileSync(join(dir, example.id, "src/index.ts"), "utf8")).toContain("src/index.ts");

    const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("Scaffolded agent-examples/gmail-retry-notify into ./gmail-retry-notify");
    expect(printed).toContain("cd gmail-retry-notify");
    expect(printed).toContain("npm install");
    expect(printed).toContain(`pome run ${firstTaskFile(example)}`);

    // `--example` does not also run the starter scaffold: the example brings
    // its own pome.json, and a second one in the cwd would shadow it.
    expect(existsSync(join(dir, "pome.json"))).toBe(false);
    expect(existsSync(join(dir, "tasks"))).toBe(false);
  });

  it("does not tell an integration example to `pome run` — its own runner owns the loop", () => {
    const example = findExample("braintrust")!;
    const summary = scaffoldSummary({ dir: example.id, example, ref: "main", fileCount: 28 });
    expect(summary).toContain("README.md");
    // No numbered step is a `pome run` — an integration example's pome.json
    // carries no `command`, so one would sit watching a sandbox nothing called.
    expect(summary).not.toMatch(/^\s*\d+\.\s*pome run/m);

    // The examinee half of the split still gets the run step, which is what
    // makes the distinction observable rather than a comment.
    const examinee = findExample("merge-agent")!;
    expect(
      scaffoldSummary({ dir: examinee.id, example: examinee, ref: "main", fileCount: 9 }),
    ).toMatch(/^\s*\d+\.\s*pome run tasks\//m);
  });

  it("refuses a target directory that already holds something", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "merge-agent"), { recursive: true });
    await writeFile(join(dir, "merge-agent", "notes.md"), "mine\n");
    const { impl, seen } = fakeFetch();

    await expect(
      scaffoldExample({ id: "merge-agent", cwd: dir, ref: "main", fetchImpl: impl }),
    ).rejects.toThrow(/already exists and is not empty/);

    expect(seen).toHaveLength(0);
    expect(readFileSync(join(dir, "merge-agent", "notes.md"), "utf8")).toBe("mine\n");
  });

  it.each(["--sdk claude", "--bare", "--starter"])(
    "refuses to combine --example with %s",
    async (flag) => {
      await tempProject();
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await createProgram().parseAsync([
        "node",
        "pome",
        "init",
        "--example",
        "merge-agent",
        ...flag.split(" "),
      ]);

      expect(process.exitCode).toBe(2);
      process.exitCode = 0;
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("cannot be combined with");
    },
  );

  it("lists the ids in `pome init --help`, so the flag documents its own vocabulary", () => {
    const init = createProgram()
      .commands.find((command) => command.name() === "init")!
      .helpInformation();
    for (const id of exampleIds()) expect(init).toContain(id);
  });
});
