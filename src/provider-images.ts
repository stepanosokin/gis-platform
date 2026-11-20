import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { imageReference, type FeaturesConfig } from './config.js';
import { CliError } from './cli-result.js';

const run = promisify(execFile);

export async function pullProviderImage(image: string) {
  let reference: ReturnType<typeof imageReference>;
  try {
    reference = imageReference(image);
  } catch (error) {
    throw new CliError('INVALID_CONFIG', 2, (error as Error).message);
  }
  if (reference.digest) return reference.digest;
  try {
    const { stdout } = await run('docker', ['pull', image], { windowsHide: true, timeout: 180_000 });
    const digest = /^Digest: (sha256:[0-9a-f]{64})\s*$/m.exec(stdout)?.[1];
    if (digest) return digest;
  } catch {
    // Docker diagnostics can include registry endpoints or credentials.
  }
  throw new CliError('FAILED', 1, 'The provider image could not be pulled and pinned.');
}

export async function pinProviderImages(config: FeaturesConfig, current: FeaturesConfig | null) {
  for (const [id, provider] of Object.entries(config.providers ?? {})) {
    if (!provider.image || provider.digest) continue;
    const previous = current?.providers?.[id];
    provider.digest = previous?.image === provider.image && previous.digest
      ? previous.digest : await pullProviderImage(provider.image);
  }
}
