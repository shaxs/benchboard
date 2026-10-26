// Build-time synthetic pin rendering only, not an authenticity or release authority.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { validateReleaseProfile } from './profiles.mjs';
export function renderSyntheticCliLoader(profile, descriptorBytes) {
  const selected = validateReleaseProfile(profile);
  if (selected.profile !== 'synthetic' || !(descriptorBytes instanceof Uint8Array) || descriptorBytes.length > 2097152) throw new TypeError('Synthetic descriptor bytes required');
  const captured = Buffer.from(descriptorBytes);
  const descriptor = JSON.parse(captured.toString('utf8'));
  if (descriptor.kind !== 'benchboard.cli.synthetic-installation.v1' || descriptor.authorization !== 'synthetic-only' || descriptor.schemaVersion !== '1.0.0') throw new TypeError('Synthetic CLI descriptor required');
  const template = fs.readFileSync(new URL('../cli/packaged-installation.mjs', import.meta.url), 'utf8');
  const marker = "const PIN = 'BENCHBOARD_UNPREPARED_CLI_DESCRIPTOR_PIN';";
  if (template.split(marker).length !== 2) throw new Error('Fixed CLI template marker unavailable');
  return Buffer.from(template.replace(marker, `const PIN = '${createHash('sha256').update(captured).digest('hex')}';`));
}
