import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FileAttemptStore } from '../attempt-store.js';
import type { ExperimentSpec, JsonObject } from '../experiment.js';
import {
  collectEgressAuditArtifact,
  createHarborExecutor,
  EGRESS_AUDIT_ARTIFACT_PATH,
  EGRESS_AUDIT_DESTINATION,
} from '../harness-executor.js';
import { selectCellResult } from '../result.js';
import { runExperiment } from '../runner.js';

const TEST_REVISION = 'd49e28f1e4ddd13d289e85a5f312a66750951932';
const EVAL_ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('present egress audit is inventoried with a sha256 prefix', () => {
  const audit = Buffer.from('{"ruleId":"tbench_domain"}\n');
  assert.deepEqual(collectEgressAuditArtifact(audit, true), {
    missing: false,
    failureReason: null,
    artifacts: [
      {
        kind: 'egress-audit',
        path: EGRESS_AUDIT_ARTIFACT_PATH,
        bytes: audit.byteLength,
        sha256: `sha256:${createHash('sha256').update(audit).digest('hex')}`,
      },
    ],
  });
});

test('an empty audit file is a clean trial, not a missing log', () => {
  const audit = Buffer.alloc(0);
  assert.deepEqual(collectEgressAuditArtifact(audit, true), {
    missing: false,
    failureReason: null,
    artifacts: [
      {
        kind: 'egress-audit',
        path: EGRESS_AUDIT_ARTIFACT_PATH,
        bytes: 0,
        sha256: `sha256:${createHash('sha256').update(audit).digest('hex')}`,
      },
    ],
  });
});

test('a missing expected audit is explicit evidence, not a clean pass', () => {
  assert.deepEqual(collectEgressAuditArtifact(undefined, true), {
    missing: true,
    failureReason: 'egress audit log missing',
    artifacts: [{ kind: 'egress-audit-missing', path: EGRESS_AUDIT_ARTIFACT_PATH }],
  });
});

test('a truncated audit is incomplete even though the file exists', () => {
  const audit = Buffer.from(
    '{"ruleId":"tbench_domain"}\n{"ruleId":"audit_truncated","host":"","normalizedPath":""}\n',
  );
  const collected = collectEgressAuditArtifact(audit, true);
  assert.equal(collected.missing, false);
  assert.equal(collected.failureReason, 'egress audit log truncated');
  assert.equal(collected.artifacts[0]?.kind, 'egress-audit');
});

test('a policy_error audit is a harness fault, not a scored subject failure', () => {
  const audit = Buffer.from('{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\n');
  const collected = collectEgressAuditArtifact(audit, true);
  assert.equal(collected.missing, false);
  assert.equal(collected.failureReason, 'egress policy error');
});

test('truncation takes precedence over an earlier policy_error', () => {
  const audit = Buffer.from(
    '{"ruleId":"policy_error"}\n{"ruleId":"audit_truncated","host":"","normalizedPath":""}\n',
  );
  assert.equal(collectEgressAuditArtifact(audit, true).failureReason, 'egress audit log truncated');
});

test('trials without an egress proxy do not invent a missing-audit artifact', () => {
  assert.deepEqual(collectEgressAuditArtifact(undefined, false), {
    missing: false,
    failureReason: null,
    artifacts: [],
  });
});

test('a missing expected audit through runAttempt is infra_failed and excluded', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected, trialConfig } = await runHarborTrial({
    auditMode: 'missing',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.equal(attempts[0]?.result.failureReason, 'egress audit log missing');
  assert.equal(selected, undefined);
  assert.deepEqual(trialConfig, [
    {
      source: '/opt/maka-egress-state/hits.jsonl',
      destination: EGRESS_AUDIT_DESTINATION,
      service: 'maka-eval-mitmproxy',
    },
  ]);
});

test('a truncated audit through runAttempt is infra_failed and excluded', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'truncated',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.equal(attempts[0]?.result.failureReason, 'egress audit log truncated');
  assert.equal(selected, undefined);
});

test('a policy_error audit through runAttempt is infra_failed and excluded', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'policy',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.equal(attempts[0]?.result.failureReason, 'egress policy error');
  assert.equal(selected, undefined);
});

test('an empty landed audit through runAttempt stays completed', { timeout: 10_000 }, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'empty',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'completed');
  assert.equal(attempts[0]?.result.score, 1);
  assert.equal(selected?.result.status, 'completed');
});

test('an unreadable expected audit is infra_failed with the artifact path', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected } = await runHarborTrial({
    auditMode: 'unreadable',
    egressProxy: true,
  });
  assert.equal(attempts[0]?.result.status, 'infra_failed');
  assert.match(
    attempts[0]?.result.failureReason ?? '',
    new RegExp(`failed to read egress audit log .*/${EGRESS_AUDIT_ARTIFACT_PATH} \\(EISDIR\\)`),
  );
  assert.equal(selected, undefined);
});

test('trials without an egress proxy still complete when the audit file is absent', {
  timeout: 10_000,
}, async () => {
  const { attempts, selected, trialConfig } = await runHarborTrial({
    auditMode: 'missing',
    egressProxy: false,
  });
  assert.equal(attempts[0]?.result.status, 'completed');
  assert.equal(selected?.result.status, 'completed');
  assert.equal(trialConfig, null);
});

async function runHarborTrial(options: {
  readonly auditMode: 'missing' | 'empty' | 'truncated' | 'policy' | 'unreadable';
  readonly egressProxy: boolean;
}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-eval-egress-audit-'));
  const executable = join(root, 'fake-python.mjs');
  const trialConfigPath = join(root, 'trial-config.json');
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { connect } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.argv.at(-1), 'utf8'));
const socket = connect(config.agent.kwargs.relay_port, config.agent.kwargs.relay_host);
socket.setEncoding('utf8');
let buffered = '';
const message = () => new Promise((resolve) => {
  const read = (chunk) => {
    buffered += chunk;
    const boundary = buffered.indexOf('\\n');
    if (boundary < 0) return;
    socket.off('data', read);
    const line = buffered.slice(0, boundary);
    buffered = buffered.slice(boundary + 1);
    resolve(JSON.parse(line));
  };
  socket.on('data', read);
});
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('error', reject);
});
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'ready', instruction: 'solve', cwd: '/workspace' }) + '\\n');
await message();
socket.write(JSON.stringify({ token: config.agent.kwargs.relay_token, kind: 'executed', termination: 'exited', exitCode: 0, stdout: '', diagnostic: { category: 'none' } }) + '\\n');
await message();
const trialPath = new URL('./' + config.trial_name + '/', new URL('file://' + config.trials_dir + '/'));
await mkdir(trialPath, { recursive: true });
await writeFile(new URL('result.json', trialPath), JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }));
await writeFile(process.env.MAKA_TEST_TRIAL_CONFIG, JSON.stringify(config.artifacts ?? null));
const mode = process.env.MAKA_TEST_AUDIT_MODE;
if (mode !== 'missing') {
  const destination = config.artifacts?.[0]?.destination ?? 'egress-hits.jsonl';
  await mkdir(new URL('./artifacts/', trialPath), { recursive: true });
  const auditUrl = new URL('./artifacts/' + destination, trialPath);
  if (mode === 'unreadable') await mkdir(auditUrl);
  else if (mode === 'empty') await writeFile(auditUrl, '');
  else if (mode === 'truncated') {
    await writeFile(auditUrl, '{"ruleId":"tbench_domain"}\\n{"ruleId":"audit_truncated","host":"","normalizedPath":""}\\n');
  } else if (mode === 'policy') {
    await writeFile(auditUrl, '{"ruleId":"policy_error","host":"","normalizedPath":"ValueError"}\\n');
  }
}
socket.end();
`,
  );
  await chmod(executable, 0o755);
  const restore = setEnvironment({
    MAKA_TEST_PYTHON: executable,
    MAKA_TEST_TRIALS: root,
    MAKA_TEST_BUNDLE: EVAL_ROOT,
    MAKA_TEST_AUDIT_MODE: options.auditMode,
    MAKA_TEST_TRIAL_CONFIG: trialConfigPath,
  });
  try {
    const store = new FileAttemptStore(join(root, 'attempts'));
    const results = await runExperiment({
      spec: experiment(),
      store,
      executor: createHarborExecutor(
        executorConfig(options.egressProxy),
        join(root, 'experiment.json'),
      ),
      subjects: [
        {
          kind: 'external',
          execute: async ({ context }) => {
            await context.execute({ command: '/bin/true', args: [], credentialEnvironment: {} });
            return {
              usage: null,
              costUsd: null,
              durationMs: 1,
              status: 'completed',
              failureReason: null,
              artifacts: [],
            };
          },
        },
      ],
    });
    const attempts = await store.list('task::1::external');
    return {
      attempts,
      selected: selectCellResult(attempts) ?? results.get('task::1::external'),
      trialConfig: JSON.parse(await readFile(trialConfigPath, 'utf8')) as unknown,
    };
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

function experiment(): ExperimentSpec {
  return {
    schemaVersion: 'maka.eval.v1' as const,
    id: 'experiment',
    benchmark: { id: 'benchmark', version: TEST_REVISION, config: { repository: 'repo' } },
    executor: { kind: 'harbor', config: executorConfig(false) },
    execution: { maxConcurrentTaskGroups: 1 },
    subjects: [{ id: 'external', kind: 'external' as const, credentials: [], config: {} }],
    tasks: [{ id: 'task', input: 'solve', config: { harbor: { path: 'tasks/task' } } }],
    repetitions: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function executorConfig(egressProxy: boolean): JsonObject {
  return {
    frameworkVersion: '0.20.0',
    pythonPathEnv: 'MAKA_TEST_PYTHON',
    trialsRootEnv: 'MAKA_TEST_TRIALS',
    environment: {},
    preparationEnvironment: ['MAKA_TEST_AUDIT_MODE', 'MAKA_TEST_TRIAL_CONFIG'],
    mounts: [],
    ...(egressProxy
      ? {
          egressProxy: {
            composeSourceEnv: 'MAKA_TEST_BUNDLE',
            composeRelativePath: 'harbor/docker-compose-egress-proxy.yaml',
            networkPolicyRelativePath: 'harbor/egress-proxy/network-policy',
            proxyUrl: 'http://maka-eval-mitmproxy:8080',
            allowedHost: 'maka-eval-mitmproxy',
            containerCaPath: '/opt/maka-egress/mitmproxy-ca-cert.pem',
          },
        }
      : {}),
  };
}

function setEnvironment(values: Record<string, string>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
