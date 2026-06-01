// Azure OpenAI provider.
// Extends OpenAI with Azure-specific URL construction and api-key auth.

import { OpenAIProvider } from "./openai.js";
import {
  type AzureProviderConfig,
  type ProviderType,
  ProviderError,
} from "./types.js";
export class AzureProvider extends OpenAIProvider {
  override readonly providerName: ProviderType = "azure";

  private readonly endpoint: string;
  private readonly apiVersion: string;
  private readonly deploymentName?: string;
  private readonly azureApiKey: string;

  constructor(config: AzureProviderConfig) {
    // We pass a dummy OpenAI config; we override doFetch/buildRequestBody
    super({
      provider: "openai",
      apiKey: config.apiKey,
      defaultModel: config.defaultModel ?? config.deploymentName ?? "gpt-4o",
      defaultHeaders: config.defaultHeaders,
    });
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.apiVersion = config.apiVersion ?? "2024-10-21";
    this.deploymentName = config.deploymentName;
    this.azureApiKey = config.apiKey;
  }

  protected override async doFetch(body: Record<string, any>): Promise<Response> {
    // Azure uses the deployment name from the URL path, or from the model field
    const deployment = this.deploymentName ?? body.model;
    if (!deployment) {
      throw new ProviderError("Azure requires a deploymentName or model", this.providerName);
    }

    const url = `${this.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${this.apiVersion}`;

    // Remove model from body since Azure uses deployment path
    const { model: _model, ...bodyWithoutModel } = body;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.azureApiKey,
        ...this.defaultHeaders,
      },
      body: JSON.stringify(bodyWithoutModel),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `Azure OpenAI API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }

    return res;
  }

  /** Azure exposes the Responses API at /openai/responses with api-key auth.
   * Reasoning summaries require a preview api-version; callers can override via
   * the `apiVersion` config. */
  protected override async responsesFetch(body: Record<string, any>): Promise<Response> {
    body.input = expandAzureResponsesInput(body.input);
    const deployment = this.deploymentName ?? body.model;
    if (!deployment) {
      throw new ProviderError("Azure requires a deploymentName or model", this.providerName);
    }
    // Azure routes by deployment in the path; keep `model` in the body too as
    // some api-versions expect it. Prefer the deployment-scoped responses route.
    const url = `${this.endpoint}/openai/responses?api-version=${this.apiVersion}`;
    const payload = JSON.stringify({ ...body, model: deployment });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.azureApiKey,
        ...this.defaultHeaders,
      },
      body: payload,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        `Azure OpenAI Responses API error ${res.status}: ${text}`,
        this.providerName,
        res.status,
        text,
      );
    }
    return res;
  }
}

/** Re-applies the assistant-with-calls expansion (mirrors the OpenAI helper). */
function expandAzureResponsesInput(input: any[]): any[] {
  const out: any[] = [];
  for (const item of input) {
    if (item && item.__assistantWithCalls) {
      if (item.text) {
        out.push({ role: "assistant", content: [{ type: "output_text", text: item.text }] });
      }
      for (const call of item.calls) out.push(call);
    } else {
      out.push(item);
    }
  }
  return out;
}
