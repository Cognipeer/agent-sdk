# Agent SDK Test Suite

Bu dizin, `@cognipeer/agent-sdk` için kapsamlı test yapısını içerir.

## Test Yapısı

> Aşağıdaki ağaç temsilîdir (tam envanter değil). Co-located unit testler `src/**/*.test.ts` altında da bulunur (örn. `src/smart/subagents/registry.test.ts`).

```
tests/
├── setup/                    # Test altyapısı ve yardımcı araçlar
│   ├── mocks/                # mockModel.ts, mockTools.ts
│   └── fixtures/             # states.ts (state factory fonksiyonları)
├── unit/                     # Unit testler (mock model — hızlı, CI)
│   ├── tool.test.ts · prompts.test.ts · parallelToolExecution.test.ts
│   ├── delegation.test.ts            # asTool delegasyon guard'ları
│   ├── subagents.test.ts             # delegate_to / spawn / parallel + nested HITL
│   ├── subagentsIntersections.test.ts# sub-agent × structured-output/guardrail/borrowed-tool
│   ├── subagentsResilience.test.ts   # snapshot round-trip, depth/cancel/fan-out hata izolasyonu
│   ├── utils/                        # stateSnapshot, toolApprovals, ...
│   ├── nodes/                        # resolver, toolLimitFinalize
│   ├── providers/                    # promptCaching, providers, ...
│   └── guardrails/                   # engine
└── integration/              # Integration testler
    ├── agent.integration.test.ts          # createAgent
    ├── smartAgent.integration.test.ts     # createSmartAgent
    ├── pauseResume.integration.test.ts    # pause/resume
    ├── askUserQuestion.integration.test.ts# ask-user
    ├── evalHarness.integration.test.ts    # eval harness regression (scripted, key gerekmez)
    └── providerMatrix.integration.test.ts # gerçek-provider matrisi (OPT-IN, env key ile)
```

## Komutlar

```bash
# Tüm testleri çalıştır (mock — API key gerekmez)
npm test

# Watch modunda
npm run test:watch

# Coverage raporu ile (eşikleri uygular)
npm run test:coverage

# Vitest UI
npm run test:ui

# Sadece kritik özellik integration paketi
npm run test:critical

# Gerçek OpenAI ile (OPENAI_API_KEY gerekli)
OPENAI_API_KEY=sk-... npm run test:real

# Gerçek-provider matrisi (ilgili env key'ler varsa o provider çalışır)
OPENAI_API_KEY=... ANTHROPIC_API_KEY=... npm run test:matrix
```

## Mock Kullanımı

### Mock Model

```typescript
import { createMockModel, createSimpleMockModel, createToolCallingMockModel } from '../setup/mocks/mockModel';

// Basit text yanıtı
const model = createSimpleMockModel(['Response 1', 'Response 2']);

// Tool çağrısı
const toolModel = createToolCallingMockModel([
  { name: 'search', args: { query: 'test' } }
]);

// Özelleştirilmiş davranış
const customModel = createMockModel({
  responses: [/* ... */],
  onInvoke: (messages) => ({ content: 'Dynamic response' }),
  delay: 100,
  shouldFail: false,
});
```

### Mock Tools

```typescript
import { echoTool, calculatorTool, failingTool, getAllMockTools } from '../setup/mocks/mockTools';

// Tek bir tool kullan
const agent = createAgent({
  tools: [echoTool],
});

// Tüm mock tool'ları kullan
const agent = createAgent({
  tools: getAllMockTools(),
});
```

### State Fixtures

```typescript
import { 
  createMinimalState,
  createConversationState,
  createStateWithToolCall,
} from '../setup/fixtures/states';

// Minimal state
const state = createMinimalState();

// Conversation state
const state = createConversationState(3); // 3 mesaj

// Tool çağrısı olan state
const state = createStateWithToolCall('search', { query: 'test' });
```

## Test Yazma Rehberi

### Unit Test Örneği

```typescript
import { describe, it, expect } from 'vitest';
import { createTool } from '../../src/tool.js';
import { z } from 'zod';

describe('createTool', () => {
  it('should create a tool with required properties', () => {
    const tool = createTool({
      name: 'test_tool',
      schema: z.object({ input: z.string() }),
      func: async (args) => args.input,
    });

    expect(tool.name).toBe('test_tool');
    expect(typeof tool.invoke).toBe('function');
  });
});
```

### Integration Test Örneği

```typescript
import { describe, it, expect } from 'vitest';
import { createAgent } from '../../src/agent.js';
import { createSimpleMockModel } from '../setup/mocks/mockModel';
import type { SmartState } from '../../src/types.js';

describe('createAgent Integration', () => {
  it('should handle a simple conversation', async () => {
    const mockModel = createSimpleMockModel(['Hello!']);
    
    const agent = createAgent({
      name: 'TestAgent',
      model: mockModel as any,
    });

    const result = await agent.invoke({
      messages: [{ role: 'user', content: 'Hi' }],
    } as SmartState);

    expect(result.messages).toHaveLength(2);
  });
});
```

## Snapshot Testlerinde Dikkat Edilmesi Gerekenler

State snapshot işlemlerinde `ctx` içindeki fonksiyonlar serialize edilemez. Test öncesi temizleme yapılmalı:

```typescript
// Fonksiyonları ctx'den temizle
const cleanState = {
  ...state,
  ctx: Object.fromEntries(
    Object.entries(state.ctx || {}).filter(([_, v]) => typeof v !== 'function')
  ),
} as SmartState;

const snapshot = agent.snapshot(cleanState);
```

## Gerçek-Provider Matrisi (opt-in)

`tests/integration/providerMatrix.integration.test.ts` her provider için aynı sözleşmeyi doğrular: native tool-calling, structured output ve token streaming. Mock'ların kanıtlayamadığı çapraz-provider davranışı buradan gelir. **İlgili env key yoksa o provider bloğu `describe.skip` olur** — CI'da key olmadan no-op'tur.

| Provider | Gerekli env değişkenleri |
|---|---|
| openai | `OPENAI_API_KEY` (`OPENAI_MODEL` ops.) |
| anthropic | `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL` ops.) |
| azure | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` |
| bedrock | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_SESSION_TOKEN`, `BEDROCK_MODEL` ops.) |
| vertex | `GOOGLE_CLOUD_PROJECT` + (`GOOGLE_VERTEX_ACCESS_TOKEN` veya `GOOGLE_SERVICE_ACCOUNT_JSON`) |

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run test:matrix   # sadece anthropic bloğu çalışır
```

## Eval Harness Regression

`tests/integration/evalHarness.integration.test.ts`, public `runSmartAgentEvalHarness(...)` API'sini **scripted (deterministik) model** ile koşar; recall / obsolete-drop / trajectory / aggregate-score matematiği runtime değiştikçe bozulmasın diye. Gerçek model gerektirmez, CI'da çalışır. Davranışsal kalite ölçümü için aynı harness'i gerçek bir modelle de besleyebilirsiniz (bkz. [Testing & Evaluation guide](../docs/guide/testing.md)).

## Coverage

Mevcut coverage eşikleri (`vitest.config.ts`), aktüel değerlerin (~stmts %72, lines %75, funcs %79, branch %60) ~4-5 puan altında — gerçek bir taban uygular ama kırılgan değildir:
- Statements: 68%
- Lines: 70%
- Functions: 75%
- Branches: 56%

`src/adapters`, `src/guardrails`, `src/utils/content`, `src/utils/traceSections` ve provider HTTP yolları (`tests/unit/providers/providerHttp.test.ts` — mock `fetch` ile `complete`/`completeStream`/hata + SSE parser + adapter köprüsü) artık testli. Kalan headroom çoğunlukla **provider streaming/request-build** yollarında (her provider'ın `buildRequestBody`'si, Vertex/Bedrock `completeStream`) — bunlar testlendikçe eşikler tekrar yükseltilmeli.

## Katkıda Bulunma

1. Yeni özellik eklerken ilgili test dosyasını da güncelleyin
2. Her public fonksiyon için en az bir unit test yazın
3. Integration testleri için mock model ve tools kullanın
4. Edge case'leri test etmeyi unutmayın
5. `npm run test:coverage` ile coverage kontrolü yapın
