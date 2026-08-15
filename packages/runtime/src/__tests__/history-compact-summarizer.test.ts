import type { ModelCallCommit } from '@maka/core/agent-run';
/**
 * Tests for buildLlmHistorySummarizer — the AI-SDK-backed LLM summary that
 * replaces the deterministic excerpt draft when wiring injects it.
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { MockLanguageModelV4 } from 'ai/test';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../test-helpers.js';
import type { RuntimeEvent, RuntimeEventContent } from '@maka/core/runtime-event';
import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';
import { ProviderRequestTracker } from '../provider-request-telemetry.js';
import type { HistoryCompactSummaryInput } from '../ai-sdk-compaction-contract.js';
import type { ModelMessage } from '../model-protocol.js';
import {
  buildLlmHistorySummarizer,
  replayPlanItemsToModelMessages,
  type AiSdkGenerateTextLike,
} from '../history-compact-summarizer.js';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import { buildHistoryCompactCheckpoint } from '../history-compact-checkpoint.js';

const ts = 1_700_000_000_000;
let __seq = 0;
function ev(overrides: Partial<RuntimeEvent> & { content?: RuntimeEventContent }): RuntimeEvent {
  __seq += 1;
  return {
    id: `evt-${__seq}`,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    ts: ts + __seq,
    partial: false,
    ...overrides,
  } as RuntimeEvent;
}

function assertStrictOpenAiToolCallFollowed(messages: ModelMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue;
    const callIds = message.content
      .filter((part) => part.type === 'tool-call')
      .map((part) => part.toolCallId);
    if (callIds.length === 0) continue;
    const answered: string[] = [];
    for (const following of messages.slice(index + 1)) {
      if (following.role !== 'tool') break;
      for (const part of following.content) {
        if (part.type === 'tool-result') answered.push(part.toolCallId);
      }
    }
    assert.deepEqual(answered, callIds);
  }
}

function inputWith(events: RuntimeEvent[], abortSignal?: AbortSignal): HistoryCompactSummaryInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    source: { foldedRuntimeEvents: events },
    ...(abortSignal ? { abortSignal } : {}),
  };
}

describe('buildLlmHistorySummarizer', () => {
  test('inherits the session provider options without imposing a compaction-only output cap', async () => {
    let seen: Parameters<AiSdkGenerateTextLike>[0] | undefined;
    const providerOptions = { openaiCompatible: { reasoningEffort: 'high' } };
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      providerOptions,
      generateText: async (options) => {
        seen = options;
        return { text: '## Goal\nX' };
      },
    });

    await summarize(
      inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
    );

    expect(seen?.providerOptions).toBe(providerOptions);
    expect(seen?.maxOutputTokens).toBe(undefined);
  });

  test('attributes provider-reported usage to one canonical history-compaction record', async () => {
    // history_compact used to write a per-call row into the frozen table. It
    // now settles through the same seam as a main send, so the record carries
    // the run it belongs to and its cost basis (#1679).
    const recorded: ModelCallAttempt[] = [];
    let now = 100;
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () =>
        new MockLanguageModelV4({
          doGenerate: {
            content: [{ type: 'text', text: '## Goal\nX' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 3, text: 3, reasoning: 0 },
            },
            warnings: [],
          },
        }),
    });

    // The backend hands over a built tracker; the summarizer assembles nothing.
    await summarize({
      ...inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      providerRequestTracker: new ProviderRequestTracker({
        traceId: 'trace-id',
        turnId: 'turn-1',
        now: () => {
          now += 10;
          return now;
        },
        newId: () => 'trace-id',
        persistCapture: async () => ({ artifactId: 'artifact-1' }),
        recordAttempt: () => {},
        accounting: {
          sessionId: 'sess-1',
          resolveRunId: () => 'run-1',
          connectionSlug: 'connection',
          providerId: 'provider',
          callKind: 'history_compact',
          record: ({ attempt }: ModelCallCommit<ModelCallAttempt>) => {
            recorded.push(attempt);
          },
        },
      }),
    });

    const attempt = decodeModelCallAttempt(recorded[0]);
    assert.equal(attempt.callKind, 'history_compact');
    assert.equal(attempt.sessionId, 'sess-1');
    assert.equal(attempt.runId, 'run-1');
    assert.equal(attempt.turnId, 'turn-1');
    assert.equal(attempt.connectionSlug, 'connection');
    assert.equal(attempt.providerId, 'provider');
    assert.equal(attempt.inputTokens, 7);
    assert.equal(attempt.outputTokens, 3);
    assert.equal(attempt.usageBasis, 'reported');
    // No pricing was wired, so the record says the price is unknown rather
    // than claiming the summarization was free.
    assert.equal(attempt.costBasis, 'unpriced');
    assert.equal(attempt.costUsd, undefined);
  });

  test('produces schema-valid tool-result messages (toolName + wrapped output) and does not fall back', async () => {
    const seen: Array<{ messages: unknown[] }> = [];
    const generateText: AiSdkGenerateTextLike = async (opts) => {
      seen.push(opts);
      return { text: '## Goal\nX' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: '读 package.json' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc1', name: 'read', args: { path: 'package.json' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc1', name: 'read', result: { name: 'maka' } },
      }),
      ev({ role: 'model', author: 'agent', content: { kind: 'text', text: 'ok' } }),
    ];

    const result = await summarize(inputWith(events));
    expect(result).toBe('## Goal\nX');

    const messages = seen[0]!.messages as Array<{
      role: string;
      content: Array<{ type: string; toolName?: string; output?: unknown }>;
    }>;
    const toolPart = messages.find((m) => m.role === 'tool')!.content[0]!;
    expect(toolPart.type).toBe('tool-result');
    // toolName must be present in AI SDK tool-result content.
    expect(toolPart.toolName).toBe('read');
    // output must be the {type, value} wrapper, not the raw result object
    expect(toolPart.output).toEqual({ type: 'json', value: { name: 'maka' } });
  });

  test('groups consecutive parallel tool calls into one assistant message', async () => {
    const seen: ModelMessage[][] = [];
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen.push(options.messages);
        return { text: '## Goal\nX' };
      },
    });

    const events: RuntimeEvent[] = [
      ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'read both files' } }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc-a', name: 'read', args: { path: 'a.ts' } },
        refs: { stepId: 'step-1' },
      }),
      ev({
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'fc-b', name: 'read', args: { path: 'b.ts' } },
        refs: { stepId: 'step-1' },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc-a', name: 'read', result: { ok: 'a' } },
      }),
      ev({
        role: 'tool',
        author: 'tool',
        content: { kind: 'function_response', id: 'fc-b', name: 'read', result: { ok: 'b' } },
      }),
    ];

    expect(await summarize(inputWith(events))).toBe('## Goal\nX');
    const messages = seen[0]!;
    const assistantCalls = messages.filter(
      (message) =>
        message.role === 'assistant' &&
        typeof message.content !== 'string' &&
        message.content.some((part) => part.type === 'tool-call'),
    );
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0]?.content).toEqual([
      { type: 'tool-call', toolCallId: 'fc-a', toolName: 'read', input: { path: 'a.ts' } },
      { type: 'tool-call', toolCallId: 'fc-b', toolName: 'read', input: { path: 'b.ts' } },
    ]);
    expect(
      messages
        .filter((message) => message.role === 'tool')
        .flatMap((message) =>
          message.content.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : [])),
        ),
    ).toEqual(['fc-a', 'fc-b']);
    assertStrictOpenAiToolCallFollowed(messages);

    const plan = buildRuntimeEventModelReplayPlan(events);
    expect(
      replayPlanItemsToModelMessages(plan.items).filter((message) => message.role === 'assistant'),
    ).toHaveLength(1);
  });

  test('does not merge sequential tool-call rounds that already have answers between them', () => {
    const messages = replayPlanItemsToModelMessages(
      buildRuntimeEventModelReplayPlan([
        ev({
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'fc-a', name: 'read', args: { path: 'a.ts' } },
        }),
        ev({
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'fc-a', name: 'read', result: { ok: 'a' } },
        }),
        ev({
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'fc-b', name: 'read', args: { path: 'b.ts' } },
        }),
        ev({
          role: 'tool',
          author: 'tool',
          content: { kind: 'function_response', id: 'fc-b', name: 'read', result: { ok: 'b' } },
        }),
      ]).items,
    );
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    assertStrictOpenAiToolCallFollowed(messages);
  });

  test('surfaces provider failures so the runtime can report the real compact reason', async () => {
    const generateText: AiSdkGenerateTextLike = async () => {
      throw new Error('model down');
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /provider_error/,
    );
  });

  test('surfaces an exhausted output budget instead of reporting a generic empty summary', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '', finishReason: 'length' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /output_length/,
    );
  });

  test('rejects non-empty partial text when the provider exhausted its output budget', async () => {
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async () => ({ text: '## Goal\npartial summary', finishReason: 'length' }),
    });

    await assert.rejects(
      summarize(
        inputWith([ev({ role: 'user', author: 'user', content: { kind: 'text', text: 'hi' } })]),
      ),
      /output_length/,
    );
  });

  test('returns undefined without calling generateText when there are no events to summarize', async () => {
    let called = false;
    const generateText: AiSdkGenerateTextLike = async () => {
      called = true;
      return { text: 'should not reach' };
    };
    const summarize = buildLlmHistorySummarizer({ resolveModel: () => 'fake-model', generateText });

    const result = await summarize(inputWith([]));

    expect(result).toBe(undefined);
    expect(called).toBe(false);
  });

  test('rolling summary sends the prior summary plus only newly folded events', async () => {
    const seen: unknown[] = [];
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (options) => {
        seen.push(options.messages);
        return { text: 'rolled' };
      },
    });
    const old = ev({
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'ALREADY_SUMMARIZED_RAW' },
    });
    const newer = ev({
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'NEWLY_EVICTED_RAW' },
    });
    const previousCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'sess-1',
      coveredRuntimeEvents: [old],
      summary: 'PRIOR_SUMMARY',
    });
    const input = inputWith([old, newer]);

    const result = await summarize({
      ...input,
      previousCheckpoint,
      newlyFoldedRuntimeEvents: [newer],
    });

    expect(result).toBe('rolled');
    const serialized = JSON.stringify(seen[0]);
    expect(serialized).toContain('PRIOR_SUMMARY');
    expect(serialized).toContain('NEWLY_EVICTED_RAW');
    expect(serialized.includes('ALREADY_SUMMARIZED_RAW')).toBe(false);
  });
});
