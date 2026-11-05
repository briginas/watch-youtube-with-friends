import { compareVersions, type RegistryResult } from './backend-generations';
import { ConnectionError, type FailureKind } from './connection-error';
import { releaseVersion, type FirebaseConfig } from './firebase/config';
import { createGenerationRegistryReader } from './generation-registry';
import { createServiceStatusReader } from './service-status';

export function generationFailure(registry: RegistryResult, requested: string, own: string, version: string): FailureKind | null {
  const entry = registry?.generations.find(item => item.generation === requested);
  if (entry?.state === 'retired') return 'generation-retired';
  if (requested === own) return null;
  return entry && compareVersions(entry.firstRelease, version) > 0 ? 'generation-update-required' : 'unsupported-generation';
}
export function createGenerationAvailability(config: FirebaseConfig, request: typeof fetch = fetch) {
  const registry = createGenerationRegistryReader(config.invitationBaseUrl, request);
  const status = createServiceStatusReader(config.invitationBaseUrl, request, config.backendGeneration);
  return {
    async read(signal?: AbortSignal, requested = config.backendGeneration) {
      const [support, incident] = await Promise.all([
        registry.read(signal), requested === config.backendGeneration ? status.read(signal) : Promise.resolve({ state: 'unknown' as const }),
      ]);
      signal?.throwIfAborted();
      const failure = generationFailure(support, requested, config.backendGeneration, releaseVersion);
      if (failure) throw new ConnectionError(failure);
      return incident;
    },
  };
}
