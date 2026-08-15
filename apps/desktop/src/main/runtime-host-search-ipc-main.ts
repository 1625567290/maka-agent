import type { StoredMessage } from '@maka/core/session';
import { runThreadSearch } from './search/thread-search.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import { toDesktopHostSessionSummary } from './runtime-host-session-catalog-ipc-main.js';
import {
  handleReconnectableRead,
  readWithFallback,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

interface RuntimeHostSearchIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: Pick<
    DesktopRuntimeHostClient,
    'listSessions' | 'openSession' | 'queryRuntimePolicy'
  >;
  /**
   * Fixture windows seed transcripts into the workspace store before the
   * Host is up. Bind this to that store so `search:thread` can return
   * content hits (with `turnId`) even when `openSession`/`loadTranscript`
   * cannot see the seed. A `null` result (missing session or read failure)
   * falls through to the Host transcript so a later Host-written session
   * in the same window is still searchable. Production omits it.
   */
  readonly readFixtureMessages?: (sessionId: string) => Promise<StoredMessage[] | null>;
}

export function registerRuntimeHostSearchIpc(
  deps: RuntimeHostSearchIpcDeps,
): void {
  handleReconnectableRead(deps.ipcMain, 'search:thread', (_event, request: unknown) =>
    runThreadSearch(request, {
      listSessions: async () =>
        (await deps.client.listSessions()).map(toDesktopHostSessionSummary),
      readMessages: async (sessionId) =>
        (await deps.readFixtureMessages?.(sessionId)) ??
        readHostTranscript(deps.client, sessionId),
      getPrivacyContext: async () => ({
        incognitoActive: (await deps.client.queryRuntimePolicy()).policy.privacy
          .incognitoActive,
      }),
    }),
  );
}

async function readHostTranscript(
  client: Pick<DesktopRuntimeHostClient, 'openSession'>,
  sessionId: string,
): Promise<StoredMessage[] | null> {
  return readWithFallback(async () => {
    const session = await client.openSession(sessionId);
    try {
      return await session.loadTranscript();
    } finally {
      await session.close();
    }
  }, null);
}
