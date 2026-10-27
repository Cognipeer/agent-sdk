// Typed error for a 400 the provider answered about the REQUEST (a parameter or
// value the model does not take), after the SDK exhausted its self-corrections.
// It extends ProviderError, so existing `catch (e) { if (e instanceof ProviderError) }`
// code (including checks on `name === "ProviderError"`) keeps working; hosts
// that want to react to the cause read `code`/`param`.

import { ProviderError } from "../providers/types.js";

export type ModelRequestErrorCode = "unsupported_parameter" | "unsupported_value" | "max_tokens_too_large" | "model_request_invalid";

export type ModelRequestErrorInit = {
  status?: number;
  code: ModelRequestErrorCode;
  param?: string;
  value?: unknown;
  supportedValues?: string[];
  /** `max_tokens_too_large` only: the most completion tokens the server says it accepts, when its message states one. */
  maxAllowed?: number;
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
  /** `code: "max_tokens_too_large"` only: the largest completion size the server states it takes (a retry with it is the caller's call). */
  readonly maxAllowed?: number;
  readonly model: string;

  constructor(init: ModelRequestErrorInit) {
    super(init.message, init.provider, init.status ?? 400, init.responseBody);
    this.status = init.status ?? 400;
    this.code = init.code;
    this.param = init.param;
    this.value = init.value;
    this.supportedValues = init.supportedValues;
    this.maxAllowed = init.maxAllowed;
    this.model = init.model;
  }
}
