/** Exit codes and the error type that every command reports. */
export const EXIT = {
  ok: 0,
  /** The page, the search or the server did not complete the request. */
  failure: 1,
  /** The command or its options are not correct. */
  usage: 2,
  /** Sign-in, plan or credits are necessary. */
  access: 3,
} as const;

const DEFAULT_CODES = new Map<number, string>([
  [EXIT.failure, "FAILED"],
  [EXIT.usage, "INVALID_USAGE"],
  [EXIT.access, "ACCESS_REQUIRED"],
]);

/** An error as --json prints it. */
export interface JsonError {
  code: string;
  message: string;
  guidance?: string;
  exitCode: number;
}

/** A failure that the CLI reports to the user and stops on. */
export class CliError extends Error {
  override name = "CliError";
  readonly exitCode: number;
  readonly guidance: string | undefined;
  /** A stable code for --json output, for example PAGE_UNAVAILABLE. */
  readonly code: string;

  constructor(
    message: string,
    exitCode: number,
    guidance?: string,
    code?: string
  ) {
    super(message);
    this.exitCode = exitCode;
    this.guidance = guidance;
    this.code = code ?? DEFAULT_CODES.get(exitCode) ?? "FAILED";
  }

  /** The error as --json prints it. */
  toJSON() {
    const suffix = ` (${this.code})`;
    const error: JsonError = {
      code: this.code,
      message: this.message.endsWith(suffix)
        ? this.message.slice(0, -suffix.length)
        : this.message,
      exitCode: this.exitCode,
    };
    if (this.guidance) {
      error.guidance = this.guidance;
    }
    return { error };
  }
}
