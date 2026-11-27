// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect bridge package maps native Error subclasses at the Effect service boundary.
export class WkbBridgeError extends Error {
  readonly code:
    | "unavailable"
    | "invalid_source"
    | "timeout"
    | "aborted"
    | "process_failed"
    | "invalid_output";

  constructor(
    code:
      | "unavailable"
      | "invalid_source"
      | "timeout"
      | "aborted"
      | "process_failed"
      | "invalid_output",
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "WkbBridgeError";
    this.code = code;
  }
}
