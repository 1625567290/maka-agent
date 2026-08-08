import assert from 'node:assert/strict';
import test from 'node:test';
import { getBuiltinPricing } from '../telemetry/builtin-pricing.js';

test('builtin pricing resolves generated models.dev base rates', () => {
  assert.deepEqual(getBuiltinPricing('openai:gpt-4o'), {
    modelKey: 'openai:gpt-4o',
    inputUsdPer1M: 2.5,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 1.25,
  });
});

test('special access-path pricing remains in the local supplement', () => {
  assert.deepEqual(getBuiltinPricing('zai-coding-plan:glm-4.7'), {
    modelKey: 'zai-coding-plan:glm-4.7',
    inputUsdPer1M: 0.6,
    outputUsdPer1M: 2.2,
  });
});

test('subscription access paths stay unpriced instead of inheriting API rates', () => {
  assert.equal(getBuiltinPricing('github-copilot:gpt-5.5'), null);
  assert.equal(getBuiltinPricing('gemini-cli:gemini-2.5-pro'), null);
});

test('tiered models stay unpriced until runtime can select a tier', () => {
  assert.equal(getBuiltinPricing('google:gemini-2.5-pro'), null);
  assert.equal(getBuiltinPricing('MiniMax:MiniMax-M3'), null);
});
