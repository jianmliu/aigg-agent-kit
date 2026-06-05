/**
 * @onchainpal/gamekit — game-design toolkit for shared, AI-NPC-populated text
 * worlds, built on @onchainpal/npc-agent. Store-agnostic: local (InMemoryStore)
 * or shared on-chain (MudStore over a Lattice MUD World).
 *
 * Also exports the AIGG platform NPC layer: fixed menu-based characters
 * (碧玄子 pricing consultant, …) that any MUD game on ai.gg can include
 * with one call — consistent platform access across all games.
 */
export { SharedWorld } from './shared-world';
export type { SharedWorldOptions, NpcRecord, NpcSummary, TalkResult } from './shared-world';

// ── AIGG platform NPCs ───────────────────────────────────────────────────────
// One call seeds all platform-level NPCs into any SharedWorld.
// Games on ai.gg call: seedAiggPlatformNpcs(world).catch(console.warn)
export { seedAiggPlatformNpcs, AIGG_NPC_IDS, AIGG_PLATFORM_NPC_IDS, AIGG_DEFAULT_ROOM, AIGG_DEFAULT_NAMES } from './aigg/platform-npcs';
export type { AiggPlatformNpcOptions } from './aigg/platform-npcs';

// ai.gg API client (public endpoints, no auth required for pricing)
export { AiggApiClient, formatGccPricing, estimateGcc } from './aigg/aigg-api-client';
export type { AiggApiClientOptions, GccPricingTable, ModelGccPricing } from './aigg/aigg-api-client';

// Menu NPC primitives (extend to build custom menu NPCs for your game)
export { menuRegistry, buildPricingMenu, renderMenu } from './aigg/menu-npc';
export type { MenuNode, MenuAction, MenuState, MenuStepResult } from './aigg/menu-npc';
