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
}
