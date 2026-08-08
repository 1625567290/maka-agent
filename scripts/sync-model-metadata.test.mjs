import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRICING_EXCLUDED_PROVIDER_TYPES,
  PROVIDERS,
  toMetadata,
  toPricing,
} from './sync-model-metadata.mjs';

const PROVIDER = { doc: 'https://example.com/docs' };
const BASE_MODEL = {
  name: 'Test Model',
  limit: { context: 128_000, output: 8_192 },
  reasoning: true,
  tool_call: true,
};

test('models.dev reasoning_options effort values pass through to thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
  });
  assert.deepEqual(metadata.thinkingOptions, { efforts: ['high', 'max'] });
});

test('models.dev facts preserve the extended metadata contract', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    description: 'A useful model',
    knowledge: '2025-12-01',
    last_updated: '2026-01-02',
    structured_output: false,
    status: 'beta',
    limit: { context: 128_000, input: 96_000, output: 8_192 },
    modalities: { input: ['text', 'image', 'pdf', 'video'], output: ['text'] },
  });
  assert.equal(metadata.description, 'A useful model');
  assert.equal(metadata.knowledgeCutoff, '2025-12-01');
  assert.equal(metadata.inputLimit, 96_000);
  assert.equal(metadata.structuredOutput, false);
  assert.equal(metadata.lastUpdated, '2026-01-02');
  assert.equal(metadata.lifecycle, 'beta');
  assert.deepEqual(metadata.modalities, { input: ['text', 'image', 'pdf'], output: ['text'] });

  assert.equal(
    toMetadata('test', 'alpha-model', PROVIDER, {
      ...BASE_MODEL,
      status: 'alpha',
    }).lifecycle,
    'alpha',
  );
});

test('models.dev pricing skips models with tiered rates until runtime supports tiers', () => {
  for (const cost of [
    { input: 3, output: 15, context_over_200k: { input: 6, output: 30 } },
    { input: 3, output: 15, tiers: [{ input: 6, output: 30 }] },
  ]) {
    assert.equal(toPricing('openai', 'gpt-test', { cost }), undefined);
  }
});

test('subscription and plan access paths do not inherit public API pricing', () => {
  assert.equal(PRICING_EXCLUDED_PROVIDER_TYPES.has('github-copilot'), true);
  assert.equal(PRICING_EXCLUDED_PROVIDER_TYPES.has('gemini-cli'), true);
  assert.equal(PRICING_EXCLUDED_PROVIDER_TYPES.has('zai-coding-plan'), true);
});

test('models.dev reasoning_options toggle passes through to thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }],
  });
  assert.deepEqual(metadata.thinkingOptions, { efforts: ['low', 'high'], toggle: true });
});

test('models without reasoning_options declare no thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, BASE_MODEL);
  assert.equal('thinkingOptions' in metadata, false);
});

test('a toggle-only model declares thinkingOptions without efforts', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'toggle' }],
  });
  assert.deepEqual(metadata.thinkingOptions, { toggle: true });
});

test('budget_tokens is recognized and skipped until a wire consumes it', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, {
    ...BASE_MODEL,
    reasoning_options: [{ type: 'budget_tokens' }, { type: 'effort', values: ['high'] }],
  });
  assert.deepEqual(metadata.thinkingOptions, { efforts: ['high'] });
});

test('an unknown reasoning_options type fails loudly instead of drifting', () => {
  assert.throws(
    () =>
      toMetadata('test', 'm', PROVIDER, {
        ...BASE_MODEL,
        reasoning_options: [{ type: 'mystery' }],
      }),
    /unsupported shape/,
  );
});

test('an empty reasoning_options list declares no thinkingOptions', () => {
  const metadata = toMetadata('test', 'm', PROVIDER, { ...BASE_MODEL, reasoning_options: [] });
  assert.equal('thinkingOptions' in metadata, false);
});

test('malformed reasoning_options are rejected as an unsupported shape', () => {
  assert.throws(
    () => toMetadata('test', 'm', PROVIDER, { ...BASE_MODEL, reasoning_options: 'effort' }),
    /unsupported shape/,
  );
  assert.throws(
    () =>
      toMetadata('test', 'm', PROVIDER, {
        ...BASE_MODEL,
        reasoning_options: [{ type: 'effort', values: 'high' }],
      }),
    /unsupported shape/,
  );
});

test('main() syncs only the mapped providers into the generated snapshot', async () => {
  // End-to-end over the real main() path (the place the kimi/stepfun orphan
  // bug lived): a fixture catalog covering every mapped source id plus one
  // unmapped neighbour; only the mapped ones may produce segments.
  const catalog = {};
  for (const sourceId of Object.values(PROVIDERS)) {
    catalog[sourceId] = {
      id: sourceId,
      name: sourceId,
      doc: `https://${sourceId}.example/docs`,
      api: `https://${sourceId}.example/v1`,
      models: {},
    };
  }
  catalog['kimi-for-coding'].api = 'https://api.kimi.com/coding/v1';
  catalog['kimi-for-coding'].models.k3 = {
    name: 'Kimi K3',
    limit: { context: 1_048_576, output: 131_072 },
    reasoning: true,
    tool_call: true,
    cost: { input: 1, output: 2 },
    reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
  };
  catalog['github-copilot'].models['gpt-5.5'] = {
    name: 'GPT-5.5',
    limit: { context: 400_000, input: 272_000, output: 128_000 },
    reasoning: true,
    tool_call: true,
    cost: { input: 5, output: 30 },
  };
  catalog.google.models['gemini-2.5-pro'] = {
    name: 'Gemini 2.5 Pro',
    limit: { context: 1_000_000, input: 900_000, output: 64_000 },
    reasoning: true,
    tool_call: true,
    cost: {
      input: 1.25,
      output: 10,
      context_over_200k: { input: 2.5, output: 15 },
    },
  };
  catalog.google.models['gemini-2.5-flash'] = {
    name: 'Gemini 2.5 Flash',
    limit: { context: 1_000_000, input: 900_000, output: 64_000 },
    reasoning: true,
    tool_call: true,
    cost: { input: 0.3, output: 2.5 },
  };
  catalog['unmapped-provider'] = {
    id: 'unmapped-provider',
    name: 'Unmapped',
    doc: 'https://example.com/docs',
    api: 'https://unmapped.example/v1',
    models: {
      'm-1': {
        name: 'M1',
        limit: { context: 8_192, output: 4_096 },
        reasoning: false,
        tool_call: true,
      },
    },
  };
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'maka-sync-'));
  const input = join(dir, 'catalog.json');
  const output = join(dir, 'out.ts');
  const pricingOutput = join(dir, 'pricing.ts');
  await writeFile(input, JSON.stringify(catalog));
  const { main } = await import('./sync-model-metadata.mjs');
  await main(['--input', input, '--output', output, '--pricing-output', pricingOutput]);
  const out = await readFile(output, 'utf8');
  const pricing = await readFile(pricingOutput, 'utf8');
  await rm(dir, { recursive: true, force: true });

  assert.match(out, /"kimi-coding-plan": \{/);
  assert.match(out, /"k3": \{/);
  assert.match(out, /"thinkingOptions":\{"efforts":\["low","high","max"\],"toggle":true\}/);
  assert.match(out, /"kimi-for-coding": \{/);
  assert.match(out, /"kimi-for-coding": \{"api":"https:\/\/api\.kimi\.com\/coding\/v1"\}/);
  assert.doesNotMatch(pricing, /"modelKey":"kimi-coding-plan:k3"/);
  assert.doesNotMatch(pricing, /"modelKey":"github-copilot:gpt-5\.5"/);
  assert.doesNotMatch(pricing, /"modelKey":"google:gemini-2\.5-pro"/);
  assert.match(pricing, /"modelKey":"google:gemini-2\.5-flash","inputUsdPer1M":0\.3/);
  assert.doesNotMatch(pricing, /"modelKey":"gemini-cli:gemini-2\.5-pro"/);
  // The unmapped provider must appear only in the directory (the complete
  // upstream catalog), never as a snapshot segment or provider fact.
  const directoryStart = out.indexOf('GENERATED_MODELS_DEV_DIRECTORY');
  assert.ok(directoryStart > 0);
  assert.doesNotMatch(out.slice(0, directoryStart), /unmapped-provider/);
  assert.match(out.slice(directoryStart), /"unmapped-provider": \{/);
});
