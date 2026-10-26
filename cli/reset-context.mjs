// Captain-owned reset request/containment policy. Accepted reset and C2 remain authorities.
import path from 'node:path';
import { openSelectedRun, readResultsContext } from './run-context.mjs';
import { loadInstallation } from './installation.mjs';
import { prepareChallengeSource } from './challenge-source.mjs';
import { externalRoot } from './filesystem.mjs';
import { CommandError } from './command-error.mjs';
import { parseArguments, summariseResult } from './init.mjs';
import { DependencyError } from '../packages/core/dependencies.mjs';

const FLAGS = ['--dependency-mode', '--prepared-root', '--source-root', '--scratch-root', '--npm-executable', '--expected-dependency-digest'];
function dependencyRequest(options) {
  const argv = [options['--output']];
  for (const flag of FLAGS) if (options[flag] !== undefined) argv.push(flag, options[flag]);
  const parsed = parseArguments(argv), dependencies = { ...parsed.dependencies, mode: parsed.dependencies.mode ?? 'none' };
  const allowed = { none: ['mode'], prepared: ['mode', 'preparedRoot', 'sourceRoot', 'expectedDependencyDigest'],
    install: ['mode', 'sourceRoot', 'scratchRoot', 'npmExecutable', 'expectedDependencyDigest'] }[dependencies.mode];
  if (Object.keys(dependencies).some(key => !allowed.includes(key))) throw new CommandError('state');
  if (dependencies.mode === 'prepared') {
    if (!dependencies.preparedRoot) throw new DependencyError('PREPARED_ROOT_REQUIRED', 'Explicit prepared cache required.');
    if (!dependencies.sourceRoot) throw new DependencyError('CACHE_PROVENANCE_REQUIRED', 'Explicit locked source required.');
  }
  if (dependencies.mode === 'install' && ['sourceRoot', 'scratchRoot', 'npmExecutable'].some(key => !dependencies[key])) throw new CommandError('state');
  return Object.freeze(dependencies);
}

export async function prepareResetContext(options) {
  const dependencies = dependencyRequest(options);
  if (!path.isAbsolute(options['--output'])) throw new CommandError('integrity');
  const opened = await openSelectedRun(options['--run']);
  const oldResults = await readResultsContext(opened);
  const protectedRoots = oldResults === null ? [] : [oldResults.resultsRoot];
  const output = externalRoot(options['--output'], [opened.runRoot, ...protectedRoots], true);
  const installation = loadInstallation();
  const prepared = prepareChallengeSource(installation);
  try {
    const manifest = opened.manifest;
    const initializationRequest = { challenge: Object.freeze({ ...installation.challenge, sourceRoot: prepared.sourceRoot }),
      toolingIdentity: installation.toolingIdentity, evaluatorIdentity: installation.evaluatorIdentity,
      dependencies, architectureId: manifest.architectureId, architectureKind: manifest.architectureKind,
      harness: manifest.harness, securityModel: manifest.securityModel,
      configuration: structuredClone(manifest.configuration),
      ...(manifest.expectedSessionPolicy === undefined ? {} : { expectedSessionPolicy: structuredClone(manifest.expectedSessionPolicy) }),
      ...(manifest.declaredCeilingMinutes == null ? {} : { declaredCeilingMinutes: manifest.declaredCeilingMinutes }) };
    return Object.freeze({ opened, request: Object.freeze({ ...opened.request, output, initializationRequest, protectedRoots }),
      dispose: prepared.dispose });
  } catch (error) { prepared.dispose(); throw error; }
}

export function summariseReset(result, sourceCleanup) {
  return Object.freeze({ ...summariseResult(result.initResult), command: 'reset', source: result.source,
    fresh: result.fresh, oldContainerMutation: result.oldContainerMutation, sourceCleanup });
}
