# Agent SDK Test Suite

Bu dizin, `@cognipeer/agent-sdk` için kapsamlı test yapısını içerir.

## Test Yapısı

```
tests/
├── setup/                    # Test altyapısı ve yardımcı araçlar
│   ├── mocks/               # Mock nesneler
│   │   ├── mockModel.ts     # LLM model mock'u
│   │   └── mockTools.ts     # Tool mock'ları koleksiyonu
│   └── fixtures/            # Test verileri
│       └── states.ts        # State factory fonksiyonları
├── unit/                    # Unit testler
│   ├── tool.test.ts         # createTool testleri
│   ├── prompts.test.ts      # buildSystemPrompt testleri
│   ├── utils/               # Utility testleri
│   │   ├── stateSnapshot.test.ts
│   │   ├── tokenManager.test.ts
│   │   └── toolApprovals.test.ts
│   ├── nodes/               # Node testleri
│   │   ├── resolver.test.ts
│   │   └── toolLimitFinalize.test.ts
│   └── guardrails/          # Guardrail testleri
│       └── engine.test.ts
└── integration/             # Integration testler
    ├── agent.integration.test.ts      # createAgent testleri
    ├── smartAgent.integration.test.ts # createSmartAgent testleri
    └── pauseResume.integration.test.ts # Pause/Resume testleri
```

## Komutlar

```bash
# Tüm testleri çalıştır
npm test

# Watch modunda testleri çalıştır
npm run test:watch

# Coverage raporu ile testleri çalıştır
npm run test:coverage

# Vitest UI ile testleri çalıştır
npm run test:ui
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

## Coverage

Mevcut coverage hedefleri:
- Lines: 30%
- Functions: 30%
- Branches: 20%
- Statements: 30%

Bu değerler başlangıç için düşük tutulmuştur. Test coverage arttıkça bu değerler yükseltilebilir.

## Katkıda Bulunma

1. Yeni özellik eklerken ilgili test dosyasını da güncelleyin
2. Her public fonksiyon için en az bir unit test yazın
3. Integration testleri için mock model ve tools kullanın
4. Edge case'leri test etmeyi unutmayın
5. `npm run test:coverage` ile coverage kontrolü yapın
