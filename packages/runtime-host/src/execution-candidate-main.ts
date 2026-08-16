#!/usr/bin/env node
import { parseInteractiveRuntimeHostCandidateArguments } from './candidate-cli.js';
import {
  createDesktopE2eExecutionCandidateDependencies,
  DESKTOP_E2E_IDLE_GRACE_MS,
  watchDesktopE2eParentProcess,
} from './desktop-e2e-execution.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';
import { installRuntimeHostLogCapture } from './process-diagnostics.js';
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from './candidate-startup-failure.js';

installRuntimeHostLogCapture();

const parsed = parseInteractiveRuntimeHostCandidateArguments(process.argv.slice(2));
const { desktopE2e, ...parsedOptions } = parsed;
const options = desktopE2e
  ? { ...parsedOptions, idleGraceMs: DESKTOP_E2E_IDLE_GRACE_MS }
  : parsedOptions;

let result: Awaited<ReturnType<typeof startExecutionRuntimeHostCandidate>>;
try {
  result = await startExecutionRuntimeHostCandidate(
    options,
    desktopE2e ? createDesktopE2eExecutionCandidateDependencies() : {},
  );
} catch (error) {
  console.error('[runtime-host] startup failed:', error);
  process.exit(candidateStartupFailureExitCode(classifyCandidateStartupFailure(error)));
}
if (result.kind === 'loser') process.exit(2);

const stopParentWatch = desktopE2e
  ? watchDesktopE2eParentProcess(() => result.host.close())
  : undefined;

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
} finally {
  stopParentWatch?.();
}
