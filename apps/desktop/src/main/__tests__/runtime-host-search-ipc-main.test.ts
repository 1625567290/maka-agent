import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createDefaultRuntimePolicy } from "@maka/core/runtime-policy";
import type { SessionCatalogProjection } from "@maka/runtime-host/protocol";
import { seedE2eFixture } from "../e2e-fixture.js";
import {
  PROMPT_RAIL_SESSION_ID,
  readE2eFixtureSessionMessages,
} from "../e2e-fixture/seed-helpers.js";
import type { IpcHandler } from "../ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "../runtime-host-client.js";
import { registerRuntimeHostSearchIpc } from "../runtime-host-search-ipc-main.js";

const workspaceRoot = await mkdtemp(
  join(tmpdir(), "maka-fixture-thread-search-"),
);
after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("fixture-seeded transcripts return content hits even when Host loadTranscript fails", async () => {
  await seedE2eFixture({
    workspaceRoot,
    fixture: {
      scenario: "chat-prompt-rail",
      workspaceName: "e2e-fixture-chat-prompt-rail",
      reducedMotion: false,
      theme: null,
      locale: null,
      timezone: null,
      platform: null,
      scrollMotion: null,
    },
  });

  let hostTranscriptReads = 0;
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client: searchClient({
      listSessions: async () => [
        catalogSession(PROMPT_RAIL_SESSION_ID, "长对话提示词导航示例"),
      ],
      openSession: async () => {
        hostTranscriptReads += 1;
        throw new Error(
          "Host transcript is empty for a fixture-seeded Session",
        );
      },
    }),
    readFixtureMessages: (sessionId) =>
      readE2eFixtureSessionMessages(workspaceRoot, sessionId),
  });

  const handler = handlers.get("search:thread");
  assert.ok(handler);

  const titleHits = expectResults(
    await handler({} as never, {
      source: "thread",
      query: "长对话",
      limit: 10,
    }),
  );
  assert.equal(titleHits[0]?.summary, "会话标题");
  assert.deepEqual(titleHits[0]?.target, {
    kind: "thread",
    sessionId: PROMPT_RAIL_SESSION_ID,
  });

  const contentHits = expectResults(
    await handler({} as never, {
      source: "thread",
      query: "第 3 个问题",
      limit: 10,
    }),
  );
  assert.equal(contentHits.length, 1);
  assert.equal(contentHits[0]?.summary, "用户消息");
  assert.deepEqual(contentHits[0]?.target, {
    kind: "thread",
    sessionId: PROMPT_RAIL_SESSION_ID,
    turnId: "turn-prompt-rail-3",
    sequence: 4,
  });
  assert.equal(hostTranscriptReads, 0);
});

test("falls back to the Host when the fixture store has no messages", async () => {
  const handlers = new Map<string, IpcHandler>();
  let closed = 0;
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client: searchClient({
      listSessions: async () => [
        catalogSession("host-only-session", "runtime-written turn"),
      ],
      openSession: async () =>
        ({
          loadTranscript: async () => [
            {
              type: "user",
              id: "host-user",
              turnId: "turn-host-only",
              ts: 1,
              text: "composer message written after the fixture seed",
            },
          ],
          close: async () => {
            closed += 1;
          },
        }) as never,
    }),
    readFixtureMessages: async () => null,
  });

  const handler = handlers.get("search:thread");
  assert.ok(handler);
  const hits = expectResults(
    await handler({} as never, {
      source: "thread",
      query: "composer message",
      limit: 10,
    }),
  );
  assert.deepEqual(hits[0]?.target, {
    kind: "thread",
    sessionId: "host-only-session",
    turnId: "turn-host-only",
    sequence: 0,
  });
  assert.equal(closed, 1);
});

test("without a fixture reader, Host transcripts still produce content hits", async () => {
  const handlers = new Map<string, IpcHandler>();
  let closed = 0;
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client: searchClient({
      listSessions: async () => [
        catalogSession(PROMPT_RAIL_SESSION_ID, "长对话提示词导航示例"),
      ],
      openSession: async () =>
        ({
          loadTranscript: async () => [
            {
              type: "user",
              id: "host-user",
              turnId: "turn-host-3",
              ts: 1,
              text: "第 3 个问题：这一段的调用链路是怎样的？",
            },
          ],
          close: async () => {
            closed += 1;
          },
        }) as never,
    }),
  });

  const handler = handlers.get("search:thread");
  assert.ok(handler);
  const hits = expectResults(
    await handler({} as never, {
      source: "thread",
      query: "第 3 个问题",
      limit: 10,
    }),
  );
  assert.deepEqual(hits[0]?.target, {
    kind: "thread",
    sessionId: PROMPT_RAIL_SESSION_ID,
    turnId: "turn-host-3",
    sequence: 0,
  });
  assert.equal(closed, 1);
});

test("without a fixture reader, a Host transcript failure yields no content hit", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostSearchIpc({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      handleReconnectableRead: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    client: searchClient({
      listSessions: async () => [
        catalogSession(PROMPT_RAIL_SESSION_ID, "长对话提示词导航示例"),
      ],
      openSession: async () => {
        throw new Error(
          "Host transcript is empty for a fixture-seeded Session",
        );
      },
    }),
  });

  const handler = handlers.get("search:thread");
  assert.ok(handler);
  assert.deepEqual(
    await handler({} as never, {
      source: "thread",
      query: "第 3 个问题",
      limit: 10,
    }),
    [],
  );
});

function expectResults(outcome: unknown): Array<{
  summary?: string;
  target?: {
    kind: string;
    sessionId: string;
    turnId?: string;
    sequence?: number;
  };
}> {
  if (!Array.isArray(outcome)) {
    assert.fail(`expected search results, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

function searchClient(
  overrides: Partial<
    Pick<DesktopRuntimeHostClient, "listSessions" | "openSession">
  >,
): Pick<
  DesktopRuntimeHostClient,
  "listSessions" | "openSession" | "queryRuntimePolicy"
> {
  return {
    listSessions: async () => [],
    openSession: async () => {
      throw new Error("openSession is not used by this test");
    },
    queryRuntimePolicy: async () => ({
      revision: 1,
      policy: createDefaultRuntimePolicy(),
    }),
    ...overrides,
  };
}

function catalogSession(id: string, name: string): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: {
      target: { kind: "host_path", path: "/workspace" },
      hostCwd: "/workspace",
    },
    createdAt: 1,
    lastUsedAt: 1,
    lastMessageAt: 1,
    name,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: "active",
    backend: "ai-sdk",
    llmConnectionSlug: "zai-live",
    connectionLocked: true,
    model: "glm-5.1",
    permissionMode: "ask",
    collaborationMode: "agent",
    orchestrationMode: "default",
  };
}
