// Tool schemas the DebugAgent exposes to its LLM. Kept in JSONSchema-shape so
// it can be fed directly into OpenAI / Anthropic tool definitions. Matches
// production's `TASK_TOOLS.combat_action` in `src/gradientbang/tools/schemas.py`.

export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, unknown>
    required: string[]
  }
}

export const COMBAT_ACTION_TOOL: ToolSchema = {
  name: "combat_action",
  description:
    "Submit your combat round decision. Call this exactly once each time you " +
    "receive a `combat.round_waiting` event — the server is waiting for your " +
    "action before the round can resolve. Valid actions: attack, brace, flee, " +
    "or pay. Provide `commit` and `target_id` when attacking; include " +
    "`to_sector` when fleeing; include `target_id` (the toll garrison) when " +
    "paying. Use the `combat_id` from the latest `combat.round_waiting` event.",
  parameters: {
    type: "object",
    properties: {
      combat_id: {
        type: "string",
        description: "Active combat encounter identifier (from combat.round_waiting).",
      },
      action: {
        type: "string",
        enum: ["attack", "brace", "flee", "pay"],
        description: "Action to perform this round.",
      },
      commit: {
        type: "integer",
        description:
          "Number of fighters to commit when attacking. Required for attack, must be > 0.",
        minimum: 0,
      },
      target_id: {
        type: "string",
        description:
          "Target combatant identifier (required for attack; also for pay when multiple toll garrisons).",
      },
      to_sector: {
        type: "integer",
        description: "Destination sector when fleeing.",
      },
      round_number: {
        type: "integer",
        description: "Optional round number hint for concurrency control.",
        minimum: 1,
      },
    },
    required: ["combat_id", "action"],
  },
}

/** The default tool set a combat-strategy DebugAgent exposes. */
export const COMBAT_STRATEGY_TOOLS: ToolSchema[] = [COMBAT_ACTION_TOOL]
