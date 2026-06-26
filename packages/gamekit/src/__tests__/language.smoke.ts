/**
 * language.smoke — 回话语言指令注入(WorldDef.language / 玩家覆盖 → NPC 的 say 语言)。
 *
 * 证:talk() 把「世界默认语言」(SharedWorldOptions.language)与「玩家覆盖」(talk.lang)
 * 合成 persona.language,经 oracle → LlmAgent.buildPrompt 注入到 prompt+system:
 *   - 'en' → 英文 say 指令(REPLY IN ENGLISH)+ 英文 system
 *   - 'zh'/缺省 → 中文对白指令
 *   - 玩家覆盖优先于世界默认(en 世界里玩家选 zh → 中文指令)
 * 只管 say 输出语言,不改人设/房间文案。
 * Run: pnpm --filter @aigg/gamekit test:language
 */
import assert from 'node:assert/strict';
import { InMemoryStore, type InferenceProvider, type InferenceRequest, type InferenceResult } from '@aigg/npc-agent';
import { SharedWorld } from '../index';

class CapturingProvider implements InferenceProvider {
  readonly id = 'capture';
  lastPrompt = ''; lastSystem = '';
  async complete(req: InferenceRequest): Promise<InferenceResult> {
    this.lastPrompt = req.prompt; this.lastSystem = req.system ?? '';
    return { text: JSON.stringify({ say: 'ok', effects: [] }), usage: { model: 'cap', inputTokens: 10, outputTokens: 10, gccCost: 0.0001 } };
  }
}

async function mkWorld(language?: 'zh' | 'en') {
  const provider = new CapturingProvider();
  const world = new SharedWorld({ store: new InMemoryStore(), provider, ...(language ? { language } : {}) });
  await world.createNpc({ id: 'npc:x', name: 'X', owner: 'host', background: 'a townsperson', room: '广场', startGcc: 1 });
  return { world, provider };
}

async function main() {
  // ① 英文世界默认 → 英文 say 指令 + 英文 system
  {
    const { world, provider } = await mkWorld('en');
    await world.talk({ npcId: 'npc:x', visitorId: 'player:p', text: 'hi' });
    assert.match(provider.lastPrompt, /REPLY IN ENGLISH/, 'en 世界:prompt 含英文 say 指令');
    assert.match(provider.lastSystem, /English/, 'en 世界:system 英文');
    assert.ok(!provider.lastPrompt.includes('中文对白'), 'en 世界:无中文 say 指令');
  }

  // ② 中文世界默认 → 中文对白指令
  {
    const { world, provider } = await mkWorld('zh');
    await world.talk({ npcId: 'npc:x', visitorId: 'player:p', text: '你好' });
    assert.match(provider.lastPrompt, /中文对白/, 'zh 世界:prompt 含中文 say 指令');
    assert.ok(!/REPLY IN ENGLISH/.test(provider.lastPrompt), 'zh 世界:无英文 say 指令');
  }

  // ③ 缺省(未声明语言)→ 走中文默认
  {
    const { world, provider } = await mkWorld(undefined);
    await world.talk({ npcId: 'npc:x', visitorId: 'player:p', text: '你好' });
    assert.match(provider.lastPrompt, /中文对白/, '缺省:中文默认');
  }

  // ④ 玩家覆盖优先于世界默认:en 世界里玩家选 zh → 中文指令
  {
    const { world, provider } = await mkWorld('en');
    await world.talk({ npcId: 'npc:x', visitorId: 'player:p', text: 'hi', lang: 'zh' });
    assert.match(provider.lastPrompt, /中文对白/, 'en 世界 + 玩家 zh 覆盖 → 中文指令');
    assert.ok(!/REPLY IN ENGLISH/.test(provider.lastPrompt), '覆盖后无英文指令');
  }

  // ⑤ 反向覆盖:zh 世界里玩家选 en → 英文指令
  {
    const { world, provider } = await mkWorld('zh');
    await world.talk({ npcId: 'npc:x', visitorId: 'player:p', text: '你好', lang: 'en' });
    assert.match(provider.lastPrompt, /REPLY IN ENGLISH/, 'zh 世界 + 玩家 en 覆盖 → 英文指令');
  }

  console.log('✓ en/zh 世界默认 · 缺省中文 · 玩家覆盖双向(en↔zh)');
  console.log('\nLANGUAGE SMOKE PASSED ✅');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
