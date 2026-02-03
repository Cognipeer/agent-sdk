// Generic base chat model contract used internally by agent-sdk.
// We intentionally keep this minimal and implementation-agnostic so that
// different framework specific models (LangChain, OpenAI SDK, Anthropic, etc.)
// can be adapted without adding hard dependencies.

import { toLangchainTools } from "./adapters/langchain.js";

export interface BaseChatMessagePart {
  type?: string; // e.g. 'text'
  text?: string;
  content?: string; // provider specific
  [key: string]: any;
}

export interface BaseChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  name?: string;
  content: string | BaseChatMessagePart[];
  // Tool call metadata (OpenAI style)
  tool_calls?: Array<{ id: string; type?: string; function?: { name: string; arguments: string } }>;
  tool_call_id?: string; // for tool response messages
  usage?: any; // optional provider usage shape
  response_metadata?: any; // optional provider wrapper metadata
  [key: string]: any; // allow extensions
}

export interface BaseChatModel {
  // Invoke should accept an array of BaseChatMessage (system/user/assistant/tool)
  invoke(messages: BaseChatMessage[], options?: { signal?: AbortSignal; cancellationToken?: { isCancellationRequested: boolean } }): Promise<BaseChatMessage>;
  // Optional streaming method that yields incremental chunks or messages
  stream?(messages: BaseChatMessage[], options?: { signal?: AbortSignal; cancellationToken?: { isCancellationRequested: boolean } }): AsyncIterable<BaseChatMessage | BaseChatMessagePart | string>;
  // Optional tool binding hook. If not present the agent will emulate simple pass-through.
  bindTools? (tools: any[]): BaseChatModel;
  // Optional metadata helpers
  modelName?: string;
  [key: string]: any; // allow arbitrary extensions
}

export type SmartModel = BaseChatModel;

export function isSmartModel(m: any): m is SmartModel {
  return !!m && typeof m === 'object' && typeof m.invoke === 'function';
}

export function withTools(model: SmartModel, tools: any[]) {
  if (model?.bindTools) return model.bindTools(tools);
  return model;
}

// --- Adapters ----------------------------------------------------------------

// Duck-type adapter for LangChain ChatModel / Runnable style objects.
// We DO NOT import LangChain here; instead we just check for common methods.
// Usage: fromLangchainModel(new ChatOpenAI(...)) returns a BaseChatModel.
export function fromLangchainModel(lcModel: any): BaseChatModel {
  if (!lcModel) throw new Error('fromLangchainModel: model is undefined/null');

  const adapted: BaseChatModel = {
    invoke: async (messages: BaseChatMessage[], options?: { signal?: AbortSignal; cancellationToken?: { isCancellationRequested: boolean } }): Promise<BaseChatMessage> => {
      // LangChain expects an array of LC message objects. If user passed LC messages already
      // they can skip adaptation; but here we accept our generic format and map to minimal LC shape.
      const normalizeContent = (content: any): any => {
        // Allow string passthrough
        if (content == null) return content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content.map((part: any) => {
            if (!part || typeof part !== 'object') return part;
            if (part.type === 'text') return { type: 'text', text: String(part.text ?? '') };
            if (part.type === 'image_url') {
              const img = (part as any).image_url;
              // Support { url }, { base64, media_type }, or string
              if (typeof img === 'string') return { type: 'image_url', image_url: { url: img } };
              if (img && typeof img === 'object') {
                if ('url' in img) return { type: 'image_url', image_url: img };
                if ('base64' in img) {
                  const media = (img as any).media_type || 'image/jpeg';
                  const dataUrl = `data:${media};base64,${(img as any).base64}`;
                  const detail = (img as any).detail;
                  return { type: 'image_url', image_url: { url: dataUrl, detail } };
                }
              }
              // Fallback
              return part;
            }
            return part;
          });
        }
        return content;
      };
      const toLC = (m: BaseChatMessage): any => {
        // If it already looks like an LC BaseMessage (has _getType or id or lc_serializable), pass through.
        if ((m as any)._getType || (m as any).lc_serializable) return m as any;
        const role = m.role;
        // Map role to LC classes via dynamic constructors if available on lcModel or global scope.
        // We avoid importing, so fallback to generic object with role/content; many LC models accept that.
        return { role, content: normalizeContent(m.content), name: m.name, tool_calls: (m as any).tool_calls, tool_call_id: (m as any).tool_call_id };
      };
      const lcMessages = messages.map(toLC);
      const response = await lcModel.invoke(lcMessages, options);
      // Convert back to BaseChatMessage (attempt best-effort extraction)
      if (response && typeof response === 'object') {
        const content = (response as any).content ?? (response as any).text ?? '';
        return {
          role: (response as any).role || 'assistant',
            content,
            tool_calls: (response as any).tool_calls,
            usage: (response as any).usage,
            response_metadata: (response as any).response_metadata,
            ...response,
        } as BaseChatMessage;
      }
      return { role: 'assistant', content: String(response ?? '') };
    },
    stream: async function* (messages: BaseChatMessage[], options?: { signal?: AbortSignal; cancellationToken?: { isCancellationRequested: boolean } }) {
      if (typeof lcModel.stream !== 'function') return;

      const normalizeContent = (content: any): any => {
        if (content == null) return content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content.map((part: any) => {
            if (!part || typeof part !== 'object') return part;
            if (part.type === 'text') return { type: 'text', text: String(part.text ?? '') };
            if (part.type === 'image_url') {
              const img = (part as any).image_url;
              if (typeof img === 'string') return { type: 'image_url', image_url: { url: img } };
              if (img && typeof img === 'object') {
                if ('url' in img) return { type: 'image_url', image_url: img };
                if ('base64' in img) {
                  const media = (img as any).media_type || 'image/jpeg';
                  const dataUrl = `data:${media};base64,${(img as any).base64}`;
                  const detail = (img as any).detail;
                  return { type: 'image_url', image_url: { url: dataUrl, detail } };
                }
              }
              return part;
            }
            return part;
          });
        }
        return content;
      };
      const toLC = (m: BaseChatMessage): any => {
        if ((m as any)._getType || (m as any).lc_serializable) return m as any;
        return { role: m.role, content: normalizeContent(m.content), name: m.name, tool_calls: (m as any).tool_calls, tool_call_id: (m as any).tool_call_id };
      };

      const lcMessages = messages.map(toLC);
      for await (const chunk of lcModel.stream(lcMessages, options)) {
        yield chunk as any;
      }
    },
    bindTools: (tools: any[]) => {
      const lcReady = toLangchainTools(tools);
      if (typeof lcModel.bindTools === 'function') {
        const bound = lcModel.bindTools(lcReady);
        return fromLangchainModel(bound);
      }
      if (typeof lcModel.bind === 'function') {
        const bound = lcModel.bind({ tools: lcReady });
        return fromLangchainModel(bound);
      }
      return adapted;
    },
    modelName: lcModel.modelName || lcModel._modelId || lcModel._llmType || lcModel.name,
    _lc: lcModel,
  };

  return adapted;
}

// Placeholder for future adapters (OpenAI SDK, Anthropic, etc.) can follow a similar pattern.

