import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOutboundMediaLoadOptions, resolveOutboundMediaLocalRoots } from "./load-options.js";

describe("media load options", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function expectResolvedOutboundMediaRoots(
    mediaLocalRoots: readonly string[] | undefined,
    expected: unknown,
  ) {
    expect(resolveOutboundMediaLocalRoots(mediaLocalRoots)).toEqual(expected);
  }

  function expectBuiltOutboundMediaLoadOptions(
    params: Parameters<typeof buildOutboundMediaLoadOptions>[0],
    expected: unknown,
  ) {
    expect(buildOutboundMediaLoadOptions(params)).toEqual(expected);
  }

  it("keeps outbound local roots undefined when none are provided", () => {
    expectResolvedOutboundMediaRoots(undefined, undefined);
    expectResolvedOutboundMediaRoots([], undefined);
  });

  it("merges provided outbound media roots with shared defaults", () => {
    const stateDir = path.join("/tmp", "openclaw-load-options-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    expectResolvedOutboundMediaRoots(
      ["/tmp/workspace"],
      expect.arrayContaining([
        path.join(stateDir, "media"),
        path.join(stateDir, "workspace"),
        path.join(stateDir, "sandboxes"),
        "/tmp/workspace",
      ]),
    );
  });

  it("builds outbound media load options with merged defaults when roots are provided", () => {
    const stateDir = path.join("/tmp", "openclaw-build-load-options-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    expectBuiltOutboundMediaLoadOptions(
      { maxBytes: 1024, mediaLocalRoots: ["/tmp/workspace"] },
      {
        maxBytes: 1024,
        localRoots: expect.arrayContaining([
          path.join(stateDir, "media"),
          path.join(stateDir, "workspace"),
          path.join(stateDir, "sandboxes"),
          "/tmp/workspace",
        ]),
      },
    );
  });

  it("builds outbound media load options without local roots when none are provided", () => {
    expectBuiltOutboundMediaLoadOptions(
      { maxBytes: 2048, mediaLocalRoots: undefined },
      { maxBytes: 2048, localRoots: undefined },
    );
  });
});
