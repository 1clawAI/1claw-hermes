export class ConfigError extends Error {
  readonly code = "CONFIG_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class VaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

export type GuardrailViolationCode =
  | "CHAIN_NOT_ALLOWED"
  | "VALUE_EXCEEDS_CAP"
  | "ADDRESS_NOT_ALLOWED";

export class GuardrailViolationError extends Error {
  readonly code: GuardrailViolationCode;
  constructor(code: GuardrailViolationCode, message: string) {
    super(message);
    this.name = "GuardrailViolationError";
    this.code = code;
  }
}
