/**
 * Scoped request logger that auto-prefixes every message with
 * [request_id] so log lines are correlated without manually
 * threading IDs through each call site.
 *
 * Note: bot_instance_id is NOT included here because the bot's
 * loguru format already tags every line (including Deno subprocess
 * output) with [BOT_INSTANCE_ID].
 */

export class RequestLogger {
  private prefix: string;

  constructor(functionName: string, requestId: string) {
    this.prefix = `${functionName} [${requestId}]`;
  }

  info(...args: unknown[]): void {
    console.log(this.prefix, ...args);
  }

  warn(...args: unknown[]): void {
    console.warn(this.prefix, ...args);
  }

  error(...args: unknown[]): void {
    console.error(this.prefix, ...args);
  }
}
