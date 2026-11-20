export class CliError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
