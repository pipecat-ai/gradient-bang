/**
 * Weave observability for Deno edge functions.
 *
 * Uses the Weave HTTP Service API directly (no npm dependencies).
 * Enabled when both WANDB_API_KEY and WEAVE_PROJECT are set.
 * All tracing is collected in-memory and flushed at the end of the request.
 */

const WANDB_API_KEY = Deno.env.get("WANDB_API_KEY");
const WEAVE_PROJECT = Deno.env.get("WEAVE_PROJECT"); // "entity/project"
const WEAVE_ENABLED = Boolean(WANDB_API_KEY && WEAVE_PROJECT);
const WEAVE_BASE_URL = "https://trace.wandb.ai";
const BOT_INSTANCE_ID = Deno.env.get("BOT_INSTANCE_ID") ?? null;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WeaveSpan {
  /** Create a child span under this span. Call span.end() when done. */
  span(opName: string, inputs?: Record<string, unknown>): WeaveSpan;
  end(output?: Record<string, unknown>): void;
}

export interface WeaveTrace {
  /** Create a child span under this trace. Call span.end() when done. */
  span(opName: string, inputs?: Record<string, unknown>): WeaveSpan;
  /** Merge additional keys into the root trace inputs (e.g. parsed request args). */
  setInput(input: Record<string, unknown>): void;
  /** Set the output for the root trace before flushing. */
  setOutput(output: Record<string, unknown>): void;
  /** Flush all collected trace data to the Weave API. */
  flush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// No-op implementations (used when Weave is disabled)
// ---------------------------------------------------------------------------

const NOOP_SPAN: WeaveSpan = { span() { return NOOP_SPAN; }, end() {} };
const NOOP_TRACE: WeaveTrace = {
  span() {
    return NOOP_SPAN;
  },
  setInput() {},
  setOutput() {},
  async flush() {},
};

// ---------------------------------------------------------------------------
// Internal data structures
// ---------------------------------------------------------------------------

interface SpanRecord {
  id: string;
  parentId: string;
  traceId: string;
  opName: string;
  startedAt: string;
  endedAt: string | null;
  inputs: Record<string, unknown>;
  output: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

class WeaveSpanImpl implements WeaveSpan {
  constructor(
    private record: SpanRecord,
    private spans: SpanRecord[],
    private traceId: string,
  ) {}

  span(opName: string, inputs?: Record<string, unknown>): WeaveSpan {
    const record: SpanRecord = {
      id: crypto.randomUUID(),
      parentId: this.record.id,
      traceId: this.traceId,
      opName,
      startedAt: new Date().toISOString(),
      endedAt: null,
      inputs: inputs ?? {},
      output: {},
    };
    this.spans.push(record);
    return new WeaveSpanImpl(record, this.spans, this.traceId);
  }

  end(output?: Record<string, unknown>) {
    this.record.endedAt = new Date().toISOString();
    if (output) {
      this.record.output = output;
    }
  }
}

class WeaveTraceImpl implements WeaveTrace {
  private rootId: string;
  private traceId: string;
  private opName: string;
  private startedAt: string;
  private endedAt: string | null = null;
  private inputs: Record<string, unknown>;
  private output: Record<string, unknown> = {};
  private spans: SpanRecord[] = [];

  constructor(opName: string, inputs: Record<string, unknown>) {
    this.rootId = crypto.randomUUID();
    this.traceId = crypto.randomUUID();
    this.opName = opName;
    this.startedAt = new Date().toISOString();
    this.inputs = inputs;
  }

  span(opName: string, inputs?: Record<string, unknown>): WeaveSpan {
    const record: SpanRecord = {
      id: crypto.randomUUID(),
      parentId: this.rootId,
      traceId: this.traceId,
      opName,
      startedAt: new Date().toISOString(),
      endedAt: null,
      inputs: inputs ?? {},
      output: {},
    };
    this.spans.push(record);
    return new WeaveSpanImpl(record, this.spans, this.traceId);
  }

  setInput(input: Record<string, unknown>) {
    Object.assign(this.inputs, input);
  }

  setOutput(output: Record<string, unknown>) {
    Object.assign(this.output, output);
  }

  async flush() {
    this.endedAt ??= new Date().toISOString();

    const auth = `Basic ${btoa("api:" + WANDB_API_KEY)}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: auth,
    };

    // Fire ALL start + end calls in a single parallel batch.
    // The Weave API handles out-of-order delivery since each call
    // carries its own id/trace_id/parent_id.
    const calls: Promise<Response>[] = [];

    // Root start
    calls.push(
      fetch(`${WEAVE_BASE_URL}/call/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          start: {
            project_id: WEAVE_PROJECT,
            id: this.rootId,
            trace_id: this.traceId,
            op_name: this.opName,
            started_at: this.startedAt,
            inputs: this.inputs,
            attributes: BOT_INSTANCE_ID
              ? { bot_instance_id: BOT_INSTANCE_ID }
              : {},
          },
        }),
      }),
    );

    for (const span of this.spans) {
      // Child start
      calls.push(
        fetch(`${WEAVE_BASE_URL}/call/start`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            start: {
              project_id: WEAVE_PROJECT,
              id: span.id,
              trace_id: span.traceId,
              parent_id: span.parentId,
              op_name: span.opName,
              started_at: span.startedAt,
              inputs: span.inputs,
              attributes: {},
            },
          }),
        }),
      );

      // Child end
      calls.push(
        fetch(`${WEAVE_BASE_URL}/call/end`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            end: {
              project_id: WEAVE_PROJECT,
              id: span.id,
              ended_at: span.endedAt ?? this.endedAt,
              output: span.output,
              summary: {},
            },
          }),
        }),
      );
    }

    // Root end
    calls.push(
      fetch(`${WEAVE_BASE_URL}/call/end`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          end: {
            project_id: WEAVE_PROJECT,
            id: this.rootId,
            ended_at: this.endedAt,
            output: this.output,
            summary: {},
          },
        }),
      }),
    );

    await Promise.allSettled(calls);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a Weave trace. Returns a no-op trace when Weave is not configured.
 */
export function createTrace(
  opName: string,
  inputs?: Record<string, unknown>,
): WeaveTrace {
  if (!WEAVE_ENABLED) {
    return NOOP_TRACE;
  }
  return new WeaveTraceImpl(opName, inputs ?? {});
}

/**
 * Wrap a Deno.serve handler with automatic Weave tracing.
 *
 * The flush is fire-and-forget: the response is returned immediately and
 * trace data is sent to Weave in the background. Deno keeps the isolate
 * alive for pending I/O so the flush completes after the response is sent.
 *
 * Usage:
 *   Deno.serve(traced("my_function", async (req, trace) => {
 *     const s = trace.span("db_query");
 *     // ... do work ...
 *     s.end({ rows: 5 });
 *     return successResponse({ ok: true });
 *   }));
 */
export function traced(
  opName: string,
  handler: (req: Request, trace: WeaveTrace) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const trace = createTrace(opName, { method: req.method });
    try {
      const response = await handler(req, trace);
      trace.setOutput({ status: response.status });
      return response;
    } catch (err) {
      trace.setOutput({
        error: err instanceof Error ? err.message : String(err),
        status: 500,
      });
      throw err;
    } finally {
      // Fire-and-forget: don't block the response on trace delivery
      trace.flush().catch((e) => console.error("weave.flush_error", e));
    }
  };
}
