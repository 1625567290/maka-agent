import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { writeConnections } from '../e2e-fixture/scenarios-settings.js';

test('connection fixture seeds the Runtime Policy catalog, not llm-connections.json', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'maka-connection-catalog-fixture-'));
  try {
    await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    await writeConnections(workspaceRoot, Date.now(), 'turn-narrative');

    await assert.rejects(
      () => access(join(workspaceRoot, 'llm-connections.json')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );

    const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
    const owner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(owner);
    if (!owner) return;
    try {
      const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const snapshot = await stores.connectionCatalog.getSnapshot();
      assert.deepEqual(
        snapshot.connections.map((connection) => connection.slug),
        ['zai-live', 'empty-fetched'],
      );
      assert.equal(snapshot.defaultTarget?.modelId, 'glm-5.1');
    } finally {
      await owner.close();
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
