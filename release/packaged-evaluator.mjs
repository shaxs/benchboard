/** Synthetic build-time template rendering, not a runtime verification override or approval. */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { validateReleaseProfile } from './profiles.mjs';

export function renderSyntheticEvaluatorVerifier(profile, descriptorBytes) {
  const selected = validateReleaseProfile(profile);
  if (selected.profile !== 'synthetic' || !(descriptorBytes instanceof Uint8Array) || descriptorBytes.length > 4194304) {
    throw new TypeError('Synthetic profile and bounded descriptor bytes required');
  }
  const captured = Buffer.from(descriptorBytes);
  const descriptor = JSON.parse(captured.toString('utf8'));
  if (descriptor.kind !== 'PackagedEvaluatorAssets' || descriptor.schemaVersion !== '1.0.0' ||
      descriptor.authorization !== 'synthetic-only') throw new TypeError('Synthetic packaged descriptor required');
  const digest = createHash('sha256').update(captured).digest('hex');
  const source = fs.readFileSync(new URL('../packages/evaluation/packaged-identity.mjs', import.meta.url), 'utf8');
  const marker = "const DESCRIPTOR_DIGEST = 'BENCHBOARD_UNPREPARED_DESCRIPTOR_PIN';";
  if (source.split(marker).length !== 2) throw new Error('Fixed verifier template marker unavailable');
  return Buffer.from(source.replace(marker, `const DESCRIPTOR_DIGEST = '${digest}';`));
}
