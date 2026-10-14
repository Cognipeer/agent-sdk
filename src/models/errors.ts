// Typed error for a 400 the provider answered about the REQUEST (a parameter or
// value the model does not take), after the SDK exhausted its self-corrections.
// It extends ProviderError, so existing `catch (e) { if (e instanceof ProviderError) }`
// code (including checks on `name === "ProviderError"`) keeps working; hosts
// that want to react to the cause read `code`/`param`.

import { ProviderError } from "../providers/types.js";

export type ModelRequestErrorCode = "unsupported_parameter" | "unsupported_value" | "model_request_invalid";

export type ModelRequestErrorInit = {
  status?: number;
  code: ModelRequestErrorCode;
  param?: string;
  value?: unknown;
  supportedValues?: string[];
  provider: string;
  model: string;
  message: string;
  responseBody?: unknown;
};

export class ModelRequestError extends ProviderError {
  readonly status: number;
  readonly code: ModelRequestErrorCode;
  readonly param?: string;
  readonly value?: unknown;
  readonly supportedValues?: string[];
  readonly model: string;

  constructor(init: ModelRequestErrorInit) {
    super(init.message, init.provider, init.status ?? 400, init.responseBody);
    this.status = init.status ?? 400;
    this.code = init.code;
    this.param = init.param;
    this.value = init.value;
    this.supportedValues = init.supportedValues;
    this.model = init.model;
  }
}
