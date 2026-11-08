import { claude } from "./claude";
import { gemini } from "./gemini";
import type { AiProvider, ProviderId } from "./types";

const PROVIDERS: Record<ProviderId, AiProvider> = { claude, gemini };

/** The provider new conversations use. Set AI_PROVIDER=gemini to switch. */
export function configuredProvider(): ProviderId {
  return process.env.AI_PROVIDER === "gemini" ? "gemini" : "claude";
}

/**
 * A conversation keeps the provider it started with, because its stored
 * history is in that provider's format.
 */
export function providerFor(id: string): AiProvider {
  return PROVIDERS[id as ProviderId] ?? claude;
}

export * from "./types";
