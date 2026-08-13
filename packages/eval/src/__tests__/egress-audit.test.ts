import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { collectEgressAuditArtifact } from '../harness-executor.js';

test('present egress audit is inventoried with a sha256 prefix', () => {
  const audit = Buffer.from('{"ruleId":"tbench_domain"}\n');
  assert.deepEqual(collectEgressAuditArtifact(audit, true), {
    missing: false,
    artifacts: [
      {
        kind: 'egress-audit',
        path: 'artifacts/egress-hits.jsonl',
        bytes: audit.byteLength,
        sha256: `sha256:${createHash('sha256').update(audit).digest('hex')}`,
      },
    ],
  });
});

test('a missing expected audit is explicit evidence, not a clean pass', () => {
  assert.deepEqual(collectEgressAuditArtifact(undefined, true), {
    missing: true,
    artifacts: [{ kind: 'egress-audit-missing', path: 'artifacts/egress-hits.jsonl' }],
  });
});

test('trials without an egress proxy do not invent a missing-audit artifact', () => {
  assert.deepEqual(collectEgressAuditArtifact(undefined, false), {
    missing: false,
    artifacts: [],
  });
});
