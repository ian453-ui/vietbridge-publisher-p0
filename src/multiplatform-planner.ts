import type { UnifiedPublication, SupportedPlatform, ValidationContext, PublicationPlan } from "./platform-contract.ts";
import { planPublication } from "./platform-contract.ts";

export type MultiplatformInput = Omit<UnifiedPublication, "platform"> & {
  targets: SupportedPlatform[];
  platformOverrides?: Partial<Record<SupportedPlatform, Partial<UnifiedPublication>>>;
};

export function planMultiplatform(input: MultiplatformInput, contexts: Partial<Record<SupportedPlatform, ValidationContext>> = {}): Record<SupportedPlatform, PublicationPlan> {
  const result = {} as Record<SupportedPlatform, PublicationPlan>;
  for (const platform of input.targets) {
    const override = input.platformOverrides?.[platform] ?? {};
    const publication = { ...input, ...override, platform } as UnifiedPublication & { targets?: unknown; platformOverrides?: unknown };
    delete publication.targets;
    delete publication.platformOverrides;
    result[platform] = planPublication(publication, contexts[platform]);
  }
  return result;
}
