// Azure OpenAI provider.
// Extends OpenAI with Azure-specific URL construction and api-key auth.

import { OpenAIProvider, expandResponsesInput } from "./openai.js";
import {
  type AzureProviderConfig,
  type ProviderType,
  ProviderError,
} from "./types.js";

/** The dated api-version used when the config names none (and for chat / embeddings under `apiVersion: "v1"`). */
const DEFAULT_API_VERSION = "2024-10-21";

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
      retry: config.retry,
      fetch: config.fetch,
      timeoutMs: config.timeoutMs,
      onModelRuleLearned: config.onModelRuleLearned,
      maxTokensParam: config.maxTokensParam,
      api: config.api,
      responsesApi: config.responsesApi,
      responsesApiModels: config.responsesApiModels,
      responsesStreaming: config.responsesStreaming,
    });
    this.endpoint = config.endpoint.replace(/\/$/, "");
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    this.deploymentName = config.deploymentName;
    this.azureApiKey = config.apiKey;
  }

  /** `apiVersion: "v1"` selects Azure's versionless v1 route, which this provider uses for the Responses API only. */
  private get usesV1Route(): boolean {
    return this.apiVersion.toLowerCase() === "v1";
  }

  /** The `api-version` of the deployment routes (chat, embeddings): the v1 route has none, so under `"v1"` a dated one stands in. */
  private get datedApiVersion(): string {
    return this.usesV1Route ? DEFAULT_API_VERSION : this.apiVersion;
  }

  /** Reasoning items only decrypt for the resource that minted them: the Azure endpoint, not the dummy OpenAI base URL, is the scope. */
  protected override responsesOrigin(model: string): string {
    return `${this.providerName}|${this.endpoint}|${model}`;
  }

  /** Azure's docs replay the output items as they came, so the reasoning item and the function call it preceded go
   * back with their ids; a reasoning item without its `id` is reported to be refused (400 `invalid_payload`). */
  protected override replaysItemIds(): boolean {
    return true;
  }

  protected override async doFetch(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    // Azure uses the deployment name from the URL path, or from the model field
    const deployment = this.deploymentName ?? body.model;
    if (!deployment) {
      throw new ProviderError("Azure requires a deploymentName or model", this.providerName);
    }

    const url = `${this.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${this.datedApiVersion}`;

    // Remove model from body since Azure uses deployment path
    const { model: _model, ...bodyWithoutModel } = body;

    const payload = JSON.stringify(bodyWithoutModel);
    const res = await this.doFetchWithRetry(() => this.httpFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.azureApiKey,
        ...this.defaultHeaders,
      },
      body: payload,
      signal,
    }), signal);

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

  /** Azure embeddings: the deployment named by the request's model (falling back
   * to the configured deployment) in the path, api-key auth. */
  protected override async embeddingsFetch(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    const deployment = body.model || this.deploymentName;
    if (!deployment) {
      throw new ProviderError("Azure embeddings require a deployment name or model", this.providerName, 400);
    }
    const url = `${this.endpoint}/openai/deployments/${deployment}/embeddings?api-version=${this.datedApiVersion}`;
    const { model: _model, ...bodyWithoutModel } = body;
    const payload = JSON.stringify(bodyWithoutModel);
    const res = await this.doFetchWithRetry(() => this.httpFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.azureApiKey,
        ...this.defaultHeaders,
      },
      body: payload,
      signal,
    }), signal);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(`Azure OpenAI embeddings API error ${res.status}: ${text}`, this.providerName, res.status, text);
    }
    return res;
  }

  /**
   * Encrypted reasoning items are new in api-version 2025-04-01-preview (2025-03-01-preview
   * is the first Responses version), so a dated version before that gets no `include`
   * for them. The v1 route, `preview` and `latest` have them; a version that cannot be read is left out.
   */
  protected override acceptsEncryptedReasoningInclude(): boolean {
    if (this.usesV1Route) return true;
    const v = this.apiVersion.toLowerCase();
    if (v === "preview" || v === "latest") return true;
    const dated = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    return dated != null && dated[1] >= "2025-04-01";
  }

  /** Azure exposes the Responses API at /openai/responses with api-key auth.
   * Reasoning summaries require a preview api-version; callers can override via
   * the `apiVersion` config. `apiVersion: "v1"` uses the versionless v1 route
   * (`/openai/v1/responses`, no `api-version` query); chat and embeddings keep
   * their dated deployment routes, so under "v1" v1 is Responses-only. */
  protected override async responsesFetch(body: Record<string, any>, signal?: AbortSignal): Promise<Response> {
    body.input = expandResponsesInput(body.input);
    const deployment = this.deploymentName ?? body.model;
    if (!deployment) {
      throw new ProviderError("Azure requires a deploymentName or model", this.providerName);
    }
    // Both routes take the deployment name as `model` in the body.
    const url = this.usesV1Route
      ? `${this.endpoint}/openai/v1/responses`
      : `${this.endpoint}/openai/responses?api-version=${this.apiVersion}`;
    const payload = JSON.stringify({ ...body, model: deployment });
    const res = await this.doFetchWithRetry(() => this.httpFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.azureApiKey,
        ...this.defaultHeaders,
      },
      body: payload,
      signal,
    }), signal);
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
