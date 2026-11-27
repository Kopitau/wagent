// @effect-diagnostics-next-line extendsNativeError:off -- Pure non-Effect bridge maps native Error subclasses at the server boundary.
export class WagentBridgeError extends Error {
  readonly code:
    | "validation"
    | "unavailable"
    | "approval_not_found"
    | "export_not_found"
    | "aborted"
    | "runtime_failed";

  constructor(
    code:
      | "validation"
      | "unavailable"
      | "approval_not_found"
      | "export_not_found"
      | "aborted"
      | "runtime_failed",
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "WagentBridgeError";
    this.code = code;
  }
}
