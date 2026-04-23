import { describe, expect, it } from "vitest"

import { DebugAgent } from "../../agent/debug_agent"
import {
  OpenAILLMClient,
  hasOpenAIKey,
} from "../../agent/openai_client"
import {
  buildCorporationInfoFromWorld,
  buildStatusFromWorld,
} from "../../agent/status"
import type { CombatId } from "../types"
import { makeHarness } from "./setup"

/**
 * Live OpenAI-backed tests. Automatically skipped when no API key is present
 * so the default `pnpm test` stays fast and offline.
 *
 * To run: set `OPENAI_API_KEY` (or `VITE_OPENAI_API_KEY`) and `OPENAI_MODEL`
 * (optional, default gpt-5-mini) before `pnpm test`.
 */
const live = hasOpenAIKey() ? describe : describe.skip

live("DebugAgent + OpenAILLMClient (live API)", () => {
  it(
    "receives combat.round_waiting and returns a combat_action tool call with valid shape",
    async () => {
      const { engine, emitter } = makeHarness()
      const alice = engine.createCharacter({
        name: "Alice",
        sector: 42,
        shipType: "corsair_raider",
      })
      const bob = engine.createCharacter({
        name: "Bob",
        sector: 42,
        shipType: "pike_frigate",
      })

      const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
      const agent = new DebugAgent({
        engine,
        emitter,
        characterId: alice,
        status,
        includeCombatStrategyFragment: true,
        llm: new OpenAILLMClient(),
      })
      agent.start(
        "You are in combat. Decide and submit an action for each round until the combat ends.",
      )

      const cid = engine.initiateCombat(alice, 42) as CombatId

      const response = await agent.decide()
      const call = response.toolCall
      expect(call).toBeTruthy()
      expect(call!.name).toBe("combat_action")
      expect(call!.arguments.combat_id).toBe(cid)
      expect(["attack", "brace", "flee", "pay"]).toContain(call!.arguments.action)

      // If the LLM picked attack, it must have chosen a valid target.
      if (call!.arguments.action === "attack") {
        expect(typeof call!.arguments.target_id).toBe("string")
        expect([alice, bob]).toContain(call!.arguments.target_id)
        expect(typeof call!.arguments.commit).toBe("number")
        expect((call!.arguments.commit as number) > 0).toBe(true)
      }
    },
    30_000,
  )

  it(
    "commits the tool call to the engine: action lands in pending_actions",
    async () => {
      const { engine, emitter } = makeHarness()
      const alice = engine.createCharacter({
        name: "Alice",
        sector: 42,
        shipType: "sparrow_scout",
      })
      engine.createCharacter({
        name: "Bob",
        sector: 42,
        shipType: "sparrow_scout",
      })

      const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
      const agent = new DebugAgent({
        engine,
        emitter,
        characterId: alice,
        status,
        includeCombatStrategyFragment: true,
        llm: new OpenAILLMClient(),
      })
      agent.start("You are in combat. Submit one action for this round.")

      const cid = engine.initiateCombat(alice, 42) as CombatId
      const outcome = await agent.decideAndCommit()

      expect(outcome.call?.name).toBe("combat_action")
      expect(outcome.result?.ok).toBe(true)

      // Engine recorded Alice's action for this round.
      const enc = engine.getWorldSnapshot().activeCombats.get(cid as never)
      expect(enc).toBeTruthy()
      expect(enc!.pending_actions[alice]).toBeTruthy()
      expect(enc!.pending_actions[alice].action).toBe(outcome.call!.arguments.action)
    },
    30_000,
  )

  it(
    "multi-round loop: Alice and Bob both LLM-driven — combat terminates",
    async () => {
      const { engine, emitter, advance, getNow } = makeHarness()
      const alice = engine.createCharacter({
        name: "Alice",
        sector: 42,
        shipType: "sparrow_scout",
      })
      const bob = engine.createCharacter({
        name: "Bob",
        sector: 42,
        shipType: "sparrow_scout",
      })
      const aliceStatus = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
      const bobStatus = buildStatusFromWorld(engine.getWorldSnapshot(), bob)
      // Both ships belong to their own pilots; no corp payload.
      const corpId = engine.createCorporation({ name: "SoloAlice", memberCharacterIds: [alice] })
      const aliceCorp = buildCorporationInfoFromWorld(engine.getWorldSnapshot(), corpId)

      const aliceAgent = new DebugAgent({
        engine,
        emitter,
        characterId: alice,
        status: aliceStatus,
        corporation: aliceCorp,
        includeCombatStrategyFragment: true,
        llm: new OpenAILLMClient(),
      })
      const bobAgent = new DebugAgent({
        engine,
        emitter,
        characterId: bob,
        status: bobStatus,
        includeCombatStrategyFragment: true,
        llm: new OpenAILLMClient(),
      })
      aliceAgent.start("Decide a combat action each round until the fight ends.")
      bobAgent.start("Decide a combat action each round until the fight ends.")

      engine.initiateCombat(alice, 42)

      // Drive up to 6 rounds — should terminate well before that for any
      // rational policy. Between rounds we tick to flush any deadlines for
      // agents that picked slow actions.
      const maxRounds = 6
      for (let round = 0; round < maxRounds; round++) {
        const active = Array.from(engine.getWorldSnapshot().activeCombats.values()).find(
          (c) => !c.ended,
        )
        if (!active) break

        // Both agents decide-and-commit in parallel.
        await Promise.all([aliceAgent.decideAndCommit(), bobAgent.decideAndCommit()])

        // If a combat is still open (e.g. agent chose a non-combat_action tool),
        // advance past deadline and tick to keep things moving.
        const stillActive = Array.from(
          engine.getWorldSnapshot().activeCombats.values(),
        ).find((c) => !c.ended)
        if (stillActive) {
          advance(31_000)
          engine.tick(getNow())
        }
      }

      // Combat must have ended.
      const anyActive = Array.from(engine.getWorldSnapshot().activeCombats.values()).find(
        (c) => !c.ended,
      )
      expect(anyActive).toBeFalsy()

      // Both agents should have received a combat.ended XML in their context.
      expect(aliceAgent.messagesFor("combat.ended").length).toBeGreaterThanOrEqual(1)
      expect(bobAgent.messagesFor("combat.ended").length).toBeGreaterThanOrEqual(1)
    },
    120_000,
  )
})

describe("OpenAILLMClient — key detection", () => {
  it("hasOpenAIKey() returns a boolean reflecting env presence", () => {
    expect(typeof hasOpenAIKey()).toBe("boolean")
  })

  // Only meaningful when NO key is configured — otherwise the test can't
  // prove the error path without mocking both process.env AND
  // import.meta.env.VITE_OPENAI_API_KEY at the module level.
  const noKey = !hasOpenAIKey()
  ;(noKey ? it : it.skip)(
    "constructor throws a clear error when no key is available",
    () => {
      expect(() => new OpenAILLMClient({ apiKey: undefined })).toThrow(
        /missing api key/i,
      )
    },
  )
})
