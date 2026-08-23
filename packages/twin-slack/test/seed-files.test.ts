/** Seeded files. WHAT WAS WRONG, stated as the thing these tests refuse. */
import { describe, expect, it } from "vitest";
import { openSlackTwinDatabase } from "../src/db.js";
import { SlackDomain } from "../src/domain/index.js";
import { defaultSeedState, parseSeed } from "../src/seed.js";
import type { SeedFile, SlackStateSeed } from "../src/types.js";

function withFiles(files: SlackStateSeed["files"]): SlackDomain {
  const db = openSlackTwinDatabase(":memory:");
  const domain = new SlackDomain(db);
  domain.seed({ ...defaultSeedState(), files });
  return domain;
}

const RUNBOOK_CONTENT = "# Runbook\n1. Page the on-call.\n";

const RUNBOOK: SeedFile = {
  id: "F_RUNBOOK",
  name: "runbook.md",
  title: "Incident runbook",
  filetype: "markdown",
  user: "alice",
  channels: ["general"],
  content: RUNBOOK_CONTENT,
};

describe("seeded files — files.list", () => {
  it("serves a seeded file, so the surface is no longer an empty array", () => {
    const listed = withFiles([{ ...RUNBOOK }]).filesList({}) as {
      files: Array<{ id: string }>;
      paging: { total: number; pages: number };
    };
    expect(listed.files.map((f) => f.id)).toEqual(["F_RUNBOOK"]);
    // `paging` is derived from the table, so it moves with the seed rather than
    // reporting the zeros an empty world produced.
    expect(listed.paging.total).toBe(1);
    expect(listed.paging.pages).toBe(1);
  });

  it("still serves an empty array when the seed declares no files", () => {
    const domain = new SlackDomain(openSlackTwinDatabase(":memory:"));
    domain.seed(defaultSeedState());
    const listed = domain.filesList({}) as { files: unknown[]; paging: { total: number } };
    expect(listed.files).toEqual([]);
    expect(listed.paging.total).toBe(0);
  });

  it("derives mimetype, size and title exactly as files.upload does", () => {
    const seeded = withFiles([{ ...RUNBOOK }]).filesList({}) as {
      files: Array<{ mimetype: string; size: number; title: string; filetype: string }>;
    };
    const uploadDomain = withFiles([]);
    const uploaded = uploadDomain.filesUpload(
      { channels: "C_GENERAL", filename: RUNBOOK.name, filetype: RUNBOOK.filetype, content: RUNBOOK.content },
      { login: "alice" },
    ) as { file: { mimetype: string; size: number; title: string; filetype: string } };

    expect(seeded.files[0]!.mimetype).toBe(uploaded.file.mimetype);
    expect(seeded.files[0]!.mimetype).toBe("text/markdown");
    expect(seeded.files[0]!.size).toBe(uploaded.file.size);
    expect(seeded.files[0]!.size).toBe(Buffer.byteLength(RUNBOOK_CONTENT, "utf8"));
    expect(seeded.files[0]!.filetype).toBe("markdown");
    // `title` was given here; `files.upload` defaults it to the filename, and so
    // does the seed — asserted separately below.
    expect(seeded.files[0]!.title).toBe("Incident runbook");
    expect(uploaded.file.title).toBe(RUNBOOK.name);
  });

  it("defaults title to name and size to 0 with no content, like files.upload", () => {
    const listed = withFiles([{ name: "empty.txt" }]).filesList({}) as {
      files: Array<{ title: string; size: number; mimetype: string; user: string }>;
    };
    expect(listed.files[0]!.title).toBe("empty.txt");
    expect(listed.files[0]!.size).toBe(0);
    expect(listed.files[0]!.mimetype).toBe("text/plain");
    // No `user` handle → the seed's agent user, not a dangling id.
    expect(listed.files[0]!.user).toBe("U_PRIMARY");
  });
});

describe("seeded files — handle resolution", () => {
  it("resolves a user handle to the seeded user id", () => {
    const listed = withFiles([{ ...RUNBOOK }]).filesList({}) as { files: Array<{ user: string }> };
    expect(listed.files[0]!.user).toBe("U_ALICE");
  });

  it("resolves a channel handle to the minted channel id", () => {
    const listed = withFiles([{ ...RUNBOOK }]).filesList({}) as { files: Array<{ channels: string[] }> };
    expect(listed.files[0]!.channels).toEqual(["C_GENERAL"]);
  });

  it("accepts an explicit channel id as well as a handle", () => {
    const listed = withFiles([{ ...RUNBOOK, channels: ["C_RANDOM"] }]).filesList({}) as {
      files: Array<{ channels: string[] }>;
    };
    expect(listed.files[0]!.channels).toEqual(["C_RANDOM"]);
  });

  it("drops a channel handle that names no seeded channel rather than storing it raw", () => {
    // Storing the raw ref would make `files.list?channel=…` filter against an id
    // no channel has: the row would claim a channel that cannot be addressed.
    const domain = withFiles([{ ...RUNBOOK, channels: ["general", "nope"] }]);
    const listed = domain.filesList({}) as { files: Array<{ channels: string[] }> };
    expect(listed.files[0]!.channels).toEqual(["C_GENERAL"]);
  });

  it("filters files.list by the seeded channel the file is shared into", () => {
    const domain = withFiles([
      { ...RUNBOOK },
      { id: "F_MEMO", name: "memo.txt", channels: ["random"] },
    ]);
    const general = domain.filesList({ channel: "C_GENERAL" }) as { files: Array<{ id: string }> };
    const random = domain.filesList({ channel: "C_RANDOM" }) as { files: Array<{ id: string }> };
    expect(general.files.map((f) => f.id)).toEqual(["F_RUNBOOK"]);
    expect(random.files.map((f) => f.id)).toEqual(["F_MEMO"]);
  });
});

describe("seeded files — files.info", () => {
  it("addresses a seeded file by its stable seed id", () => {
    // This is what made `GET /files.info` a documented capture EXCEPTION: with
    // no seedable file there was no stable id to address.
    const info = withFiles([{ ...RUNBOOK }]).filesInfo({ file: "F_RUNBOOK" }) as {
      file: { id: string; name: string };
    };
    expect(info.file.id).toBe("F_RUNBOOK");
    expect(info.file.name).toBe("runbook.md");
  });

  it("mints an F-prefixed id when the seed does not pin one", () => {
    const listed = withFiles([{ name: "minted.txt" }]).filesList({}) as { files: Array<{ id: string }> };
    expect(listed.files[0]!.id).toMatch(/^F/);
  });
});

describe("seeded files — schema", () => {
  it("defaults files to an empty array so every existing seed still parses", () => {
    expect(parseSeed({}).files).toEqual([]);
  });

  it("rejects an id that is not Slack-file-shaped", () => {
    expect(() => parseSeed({ files: [{ id: "C_NOPE", name: "x.txt" }] })).toThrow();
  });

  it("rejects a file with no name", () => {
    expect(() => parseSeed({ files: [{ title: "no name" }] })).toThrow();
  });

  it("reseeding wipes previously seeded files rather than accumulating them", () => {
    const domain = withFiles([{ ...RUNBOOK }]);
    domain.seed({ ...defaultSeedState(), files: [{ id: "F_OTHER", name: "other.txt" }] });
    const listed = domain.filesList({}) as { files: Array<{ id: string }> };
    expect(listed.files.map((f) => f.id)).toEqual(["F_OTHER"]);
  });
});

describe("seeded files — state export", () => {
  it("reports seeded files in the exported state", () => {
    const state = withFiles([{ ...RUNBOOK }]).exportState() as { files: Array<{ id: string }> };
    expect(state.files.map((f) => f.id)).toEqual(["F_RUNBOOK"]);
  });
});
