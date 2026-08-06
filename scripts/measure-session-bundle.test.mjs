import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createSessionStore, exportSessionBundleState } from '@maka/storage';
import {
  prepareStateExport,
  readSessionExportId,
  redactText,
  sanitizeJsonFile,
} from './measure-session-bundle.mjs';

const scriptPath = fileURLToPath(new URL('./measure-session-bundle.mjs', import.meta.url));

test('session bundle measurement rejects overlapping workspace and export roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-overlap-'));
  const workspace = join(root, 'workspace');
  const sessionExport = join(workspace, 'session-export');
  try {
    await mkdir(sessionExport, { recursive: true });

    const error = await runFailure([
      scriptPath,
      '--workspace',
      workspace,
      '--session-export',
      sessionExport,
      '--boot-samples',
      '1',
    ]);
    assert.match(error, /workspace and session export roots must not overlap/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle sanitization redacts secrets', async () => {
  assert.equal(redactText('token = top-secret'), 'token = [REDACTED]');

  const root = await mkdtemp(join(tmpdir(), 'maka-session-bundle-sanitize-'));
  try {
    const secret = join(root, 'secret.json');
    const secretOutput = join(root, 'secret-output.json');
    await writeFile(secret, '{\n  "token": "secret-value",\n  "answer": 42\n}\n');
    await sanitizeJsonFile(secret, secretOutput);
    assert.equal(await readFile(secretOutput, 'utf8'), '{"token":"[REDACTED]","answer":42}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session bundle measurement reads identity from the exported operational-state database', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-identity-'));
  try {
    const { sessionId, exportRoot } = await createSessionExport(base);
    assert.equal(await readSessionExportId(exportRoot), sessionId);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session bundle measurement materializes a real state export', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-prepare-'));
  try {
    const { sessionId, exportRoot } = await createSessionExport(base);
    const destination = join(base, 'materialized');

    await prepareStateExport(exportRoot, destination, sessionId);

    assert.ok((await stat(join(destination, 'runtime.sqlite'))).isFile());
    assert.equal(await readSessionExportId(destination), sessionId);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session bundle measurement leaves the supplied export untouched', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-immutable-'));
  try {
    const { sessionId, exportRoot } = await createSessionExport(base);
    const before = (await readdir(exportRoot)).sort();

    await prepareStateExport(exportRoot, join(base, 'first'), sessionId);

    assert.deepEqual((await readdir(exportRoot)).sort(), before);
    // A read that materialized -wal/-shm beside the database would write into an
    // export the caller owns, and this second run would reject its own leftovers.
    await prepareStateExport(exportRoot, join(base, 'second'), sessionId);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects a stray database sidecar in the supplied export', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-sidecar-'));
  try {
    const { sessionId, exportRoot } = await createSessionExport(base);
    // The identity read is immutable, so it ignores a sidecar rather than honoring
    // it. Tolerating one here would let a stale database drive the measurement.
    await writeFile(join(exportRoot, 'runtime.sqlite-wal'), '');

    await assert.rejects(
      prepareStateExport(exportRoot, join(base, 'materialized'), sessionId),
      /protected or unclassified state entry: runtime\.sqlite-wal/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session bundle measurement screens the export tree before opening the database', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-screen-'));
  const exportRoot = join(base, 'unscreened-export');
  try {
    await mkdir(exportRoot, { recursive: true });
    await writeFile(join(exportRoot, 'runtime.sqlite'), 'not a database');
    await writeFile(join(exportRoot, 'runtime.sqlite-wal'), '');

    // Both faults are present, so the message says which check ran first. Screening
    // after the open reports the unreadable database instead, and that ordering is
    // what lets an immutable read silently ignore a sidecar it should have refused.
    await assert.rejects(
      prepareStateExport(exportRoot, join(base, 'materialized')),
      /protected or unclassified state entry: runtime\.sqlite-wal/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects a legacy sessions/** export', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-legacy-'));
  const exportRoot = join(base, 'legacy-export');
  try {
    await mkdir(join(exportRoot, 'sessions', 'session-legacy'), { recursive: true });
    await writeFile(join(exportRoot, 'sessions', 'session-legacy', 'session.jsonl'), '{}\n');

    await assert.rejects(
      prepareStateExport(exportRoot, join(base, 'materialized')),
      /protected or unclassified state entry: sessions\/session-legacy\/session\.jsonl/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('session bundle measurement rejects an export with no operational-state database', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-session-bundle-empty-'));
  const exportRoot = join(base, 'empty-export');
  try {
    await mkdir(exportRoot, { recursive: true });

    await assert.rejects(
      prepareStateExport(exportRoot, join(base, 'materialized')),
      /session export has no runtime\.sqlite/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

async function createSessionExport(base) {
  const stateRoot = join(base, 'state');
  const configRoot = join(base, 'config');
  const exportRoot = join(base, 'export');
  await mkdir(configRoot, { recursive: true });
  const sessions = createSessionStore(stateRoot);
  const session = await sessions.create({
    cwd: join(base, 'cwd'),
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Measured',
    labels: [],
  });
  await sessions.appendMessage(session.id, {
    type: 'user',
    id: 'measured-message',
    turnId: 'turn-1',
    ts: 1,
    text: 'measured-message',
  });
  await sessions.close?.();
  await exportSessionBundleState({
    stateRoot,
    configRoot,
    destinationRoot: exportRoot,
    sessionId: session.id,
  });
  return { sessionId: session.id, exportRoot };
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`measurement exited with ${code ?? signal}: ${stderr}`));
    });
  });
}

function runFailure(args) {
  return run(args).then(
    () => Promise.reject(new Error('measurement unexpectedly succeeded')),
    (error) => error.message,
  );
}
