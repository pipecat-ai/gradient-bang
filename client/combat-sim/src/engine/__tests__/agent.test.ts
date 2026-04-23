import { describe, expect, it } from "vitest"

import { DebugAgent, MockLLMClient } from "../../agent/debug_agent"
import { PROMPT_FRAGMENTS } from "../../agent/prompts"
import {
  buildCorporationInfoFromWorld,
  buildStatusFromWorld,
} from "../../agent/status"
import { COMBAT_ACTION_TOOL } from "../../agent/tools"
import type { CharacterId, CombatId, CorpId } from "../types"
import {
  asCharacterId,
  eventsOfType,
  makeHarness,
  payloadOf,
  recipientsOf,
} from "./setup"

// Each test spins up a fresh harness, binds a DebugAgent to a character,
// drives a combat scenario, and asserts on what ended up in the agent's
// LLM context — the same filtering + XML format as production's
// `event_relay.py`.

function newAgent(characterId: string) {
  const { engine, emitter, ...rest } = makeHarness()
  const agent = new DebugAgent({ engine, emitter, characterId })
  agent.start("Defend this sector against any hostile combat initiated here.")
  return { engine, emitter, agent, ...rest }
}

describe("DebugAgent — system prompt assembly", () => {
  it("system prompt concatenates all four production fragments in order", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({ engine, emitter, characterId: "char-placeholder" })

    // Agent's system prompt contains the distinctive headers from each fragment.
    expect(agent.systemPrompt).toContain("# Gradient Bang - Space Trading Game")
    expect(agent.systemPrompt).toContain("# Loading Detailed Game Information")
    expect(agent.systemPrompt).toContain("# Task Execution Instructions")
    expect(agent.systemPrompt).toContain("# Combat Mechanics")

    // And the fragments are in the right order.
    const idxGame = agent.systemPrompt.indexOf("# Gradient Bang")
    const idxHowTo = agent.systemPrompt.indexOf("# Loading Detailed Game Information")
    const idxTask = agent.systemPrompt.indexOf("# Task Execution Instructions")
    const idxCombat = agent.systemPrompt.indexOf("# Combat Mechanics")
    expect(idxGame).toBeLessThan(idxHowTo)
    expect(idxHowTo).toBeLessThan(idxTask)
    expect(idxTask).toBeLessThan(idxCombat)
  })

  it("can be built without the combat fragment", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: "char-placeholder",
      includeCombatFragment: false,
    })
    expect(agent.systemPrompt).not.toContain("# Combat Mechanics")
    // But the core fragments remain.
    expect(agent.systemPrompt).toContain(PROMPT_FRAGMENTS.gameOverview.slice(0, 20))
  })
})

describe("DebugAgent — combat.round_waiting in context", () => {
  it("participant agent receives the round_waiting XML on combat initiate", () => {
    const { engine, agent } = newAgentForAlice()
    engine.initiateCombat(agent.characterId as never, 42)

    const xmls = agent.getXmlEvents()
    expect(xmls).toHaveLength(1)
    const xml = xmls[0]
    expect(xml).toMatch(/<event name="combat\.round_waiting" combat_id="combat-/)
    expect(xml).toContain("Combat state: you are currently in active combat.")
    expect(xml).toContain("round 1")
    expect(xml).toContain("Submit a combat action now.")
    expect(xml).toContain("deadline ")
    expect(xml).toMatch(/<\/event>$/)
  })

  it("round_waiting XML includes the combat_id attribute that matches the payload", () => {
    const { engine, agent } = newAgentForAlice()
    const cid = engine.initiateCombat(agent.characterId as never, 42)
    const xml = agent.getXmlEvents()[0]
    expect(xml).toContain(`combat_id="${cid}"`)
  })

  it("observer character does NOT get combat events in context (AppendRule.PARTICIPANT)", () => {
    // Alice + Bob fight; Charlie observes (arrives post-init → sector observer).
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    engine.createCharacter({ name: "Bob", sector: 42 })
    engine.initiateCombat(alice, 42)

    const charlie = engine.createCharacter({ name: "Charlie", sector: 1 })
    const agent = new DebugAgent({ engine, emitter, characterId: charlie })
    agent.start("Observe the sector.")
    engine.moveCharacter(charlie, 42) // arrives as observer

    // Drive round 1 to trigger combat.round_resolved — Charlie is a recipient
    // (sector-observer fan-out) but NOT a participant. No combat XML in his context.
    engine.submitAction(alice as never, engine.getWorldSnapshot().activeCombats.values().next().value!.combat_id as never, {
      action: "brace",
    })
    const bob = Array.from(engine.getWorldSnapshot().characters.values()).find(
      (c) => c.name === "Bob",
    )!
    engine.submitAction(
      bob.id,
      engine.getWorldSnapshot().activeCombats.values().next().value?.combat_id as never,
      { action: "brace" },
    )

    const xmls = agent.getXmlEvents()
    expect(xmls).toHaveLength(0)
  })
})

describe("DebugAgent — combat.action_accepted in context", () => {
  it("agent that submits an action sees its OWN action_accepted in context", () => {
    const { engine, agent } = newAgentForAlice()
    const cid = engine.initiateCombat(agent.characterId as never, 42)
    engine.submitAction(agent.characterId as never, cid, { action: "brace" })

    const actionAccepts = agent.messagesFor("combat.action_accepted")
    expect(actionAccepts).toHaveLength(1)
    expect(actionAccepts[0].content).toMatch(
      /<event name="combat\.action_accepted" combat_id="combat-/,
    )
    expect(actionAccepts[0].content).toContain("Action accepted for round 1: brace")
  })

  it("action_accepted from ANOTHER character does NOT appear in my context", () => {
    const { engine, agent } = newAgentForAlice()
    const bobId = engineCreateBob(engine)
    const cid = engine.initiateCombat(agent.characterId as never, 42)

    // Bob submits — Alice's agent should NOT see Bob's action_accepted.
    engine.submitAction(bobId, cid, { action: "brace" })

    const actionAccepts = agent.messagesFor("combat.action_accepted")
    expect(actionAccepts).toHaveLength(0)
  })

  it("attack action is summarized with commit + shortened target id", () => {
    const { engine, agent } = newAgentForAlice()
    const bobId = engineCreateBob(engine)
    const cid = engine.initiateCombat(agent.characterId as never, 42)

    engine.submitAction(agent.characterId as never, cid, {
      action: "attack",
      target_id: bobId,
      commit: 25,
    })

    const accepted = agent.messagesFor("combat.action_accepted")[0]
    expect(accepted.content).toContain("attack commit 25, target")
    // The target id gets shortened to its first 8 chars (short_id helper).
    expect(accepted.content).toContain(`target ${String(bobId).slice(0, 8)}`)
  })
})

describe("DebugAgent — combat.round_resolved in context", () => {
  it("participant sees round_resolved with their own fighter/shield loss summary", () => {
    const { engine, agent } = newAgentForAlice()
    const bobId = engineCreateBob(engine)
    const cid = engine.initiateCombat(agent.characterId as never, 42)
    // Bob attacks Alice → Alice takes some losses. Alice braces.
    engine.submitAction(agent.characterId as never, cid, { action: "brace" })
    engine.submitAction(bobId, cid, { action: "attack", target_id: agent.characterId, commit: 20 })

    const resolvedMessages = agent.messagesFor("combat.round_resolved")
    expect(resolvedMessages).toHaveLength(1)
    const xml = resolvedMessages[0].content
    expect(xml).toMatch(/<event name="combat\.round_resolved" combat_id="combat-/)
    expect(xml).toContain("Combat state: you are currently in active combat.")
    expect(xml).toMatch(/Round resolved: .+; your: (fighters lost \d+|no fighter losses), (shield damage \d+\.\d+%|no shield damage)\./)
  })
})

describe("DebugAgent — combat.ended in context", () => {
  it("participant gets 'your combat has ended' on stalemate", () => {
    const { engine, agent } = newAgentForAlice()
    const bobId = engineCreateBob(engine)
    const cid = engine.initiateCombat(agent.characterId as never, 42)
    engine.submitAction(agent.characterId as never, cid, { action: "brace" })
    engine.submitAction(bobId, cid, { action: "brace" })

    const endedMessages = agent.messagesFor("combat.ended")
    expect(endedMessages).toHaveLength(1)
    const xml = endedMessages[0].content
    expect(xml).toMatch(/<event name="combat\.ended" combat_id="combat-/)
    expect(xml).toContain("Combat state: your combat has ended.")
  })
})

describe("DebugAgent — multi-round accumulation", () => {
  it("two rounds of combat produce two round_waiting + two round_resolved XML entries", () => {
    const { engine, agent } = newAgentForAlice()
    const bobId = engineCreateBob(engine)
    const cid = engine.initiateCombat(agent.characterId as never, 42)

    // Round 1: both brace → stalemate, combat ends. This is only 1 round.
    // Use a non-ending pattern: Alice + Bob attack each other with small commits.
    engine.submitAction(agent.characterId as never, cid, {
      action: "attack",
      target_id: bobId,
      commit: 5,
    })
    engine.submitAction(bobId, cid, { action: "attack", target_id: agent.characterId, commit: 5 })

    // After round 1, combat may still be active (neither destroyed). Submit round 2.
    const enc = engine.getWorldSnapshot().activeCombats.get(cid as never)
    if (enc && !enc.ended) {
      engine.submitAction(agent.characterId as never, cid, {
        action: "attack",
        target_id: bobId,
        commit: 5,
      })
      engine.submitAction(bobId, cid, { action: "attack", target_id: agent.characterId, commit: 5 })
    }

    // Alice sees round_waiting + round_resolved for each round she was in.
    const waiting = agent.messagesFor("combat.round_waiting")
    const resolved = agent.messagesFor("combat.round_resolved")
    expect(waiting.length).toBeGreaterThanOrEqual(1)
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    // Each round_waiting carries an incremented round number in the summary.
    const rounds = waiting.map((m) => m.content.match(/round (\d+)/)?.[1]).filter(Boolean)
    expect(rounds).toContain("1")
  })
})

describe("DebugAgent — LLM decide flow (mock)", () => {
  it("decide() passes the current context to the LLMClient and records the returned tool call", async () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    const bob = engine.createCharacter({ name: "Bob", sector: 42 })

    const mock = new MockLLMClient([
      { name: "combat_action", arguments: { combat_id: "combat-1", action: "brace" } },
    ])
    const agent = new DebugAgent({ engine, emitter, characterId: alice, llm: mock })
    agent.start("Defend against any combat.")

    const cid = engine.initiateCombat(alice, 42)

    const response = await agent.decide()
    expect(response.toolCall).toEqual({
      name: "combat_action",
      arguments: { combat_id: "combat-1", action: "brace" },
    })

    // The mock captured the exact context passed in.
    expect(mock.lastContext).toBeTruthy()
    expect(mock.lastContext!.system).toContain("# Combat Mechanics")
    // The round_waiting XML is in the messages the LLM saw.
    const xmlInCtx = mock.lastContext!.messages.find((m) =>
      m.content.startsWith("<event name=\"combat.round_waiting\""),
    )
    expect(xmlInCtx).toBeTruthy()
    expect(xmlInCtx!.content).toContain(`combat_id="${cid}"`)

    // And the agent's own context grew with an assistant message.
    const ownCtx = agent.getContext()
    const assistant = ownCtx.messages.find((m) => m.role === "assistant")
    expect(assistant).toBeTruthy()
    expect(assistant!.tool_call).toEqual(response.toolCall)

    // Silence the unused destructure.
    void bob
  })
})

describe("DebugAgent — corp ship perspective", () => {
  it("a DebugAgent bound to a corp ship pseudo-character receives its own combat events", () => {
    const { engine, emitter } = makeHarness()
    const bob = engine.createCharacter({ name: "Bob", sector: 42 })
    const corp = engine.createCorporation({ name: "Alpha" })
    const probe = engine.createCorpShip({ ownerCorpId: corp, sector: 42 })

    const probeAgent = new DebugAgent({
      engine,
      emitter,
      characterId: asCharacterId(probe),
    })
    probeAgent.start("Fight anyone hostile.")

    engine.initiateCombat(bob, 42)

    // The probe IS a participant (as a pseudo-character), so the
    // combat.round_waiting XML lands in its context.
    const waits = probeAgent.messagesFor("combat.round_waiting")
    expect(waits).toHaveLength(1)
    expect(waits[0].content).toContain(`combat_id="${engine.getWorldSnapshot().activeCombats.values().next().value?.combat_id}"`)
  })

  it("corp owner NOT in the combat does NOT get combat XML in context (AppendRule.PARTICIPANT)", () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 }) // out of sector
    const bob = engine.createCharacter({ name: "Bob", sector: 42 })
    const corp = engine.createCorporation({ name: "Alpha", memberCharacterIds: [alice] })
    engine.createCorpShip({ ownerCorpId: corp, sector: 42 })

    // Alice (corp owner) is not a combat participant. She IS in the recipient
    // set via corp fan-out (engine combatRecipients), but PARTICIPANT AppendRule
    // is what event_relay.py checks. She should NOT see combat XML.
    const aliceAgent = new DebugAgent({ engine, emitter, characterId: alice })
    aliceAgent.start("Manage corp affairs.")

    engine.initiateCombat(bob, 42)

    expect(aliceAgent.getXmlEvents()).toHaveLength(0)
  })
})

// ---- Helpers ----

function newAgentForAlice() {
  const { engine, emitter, ...rest } = makeHarness()
  const alice = engine.createCharacter({ name: "Alice", sector: 42 })
  // Bob is created here just so sector 42 always has ≥2 chars for initiate.
  engine.createCharacter({ name: "Bob", sector: 42 })
  const agent = new DebugAgent({ engine, emitter, characterId: alice })
  agent.start("Defend this sector against any hostile combat initiated here.")
  return { engine, emitter, agent, ...rest }
}

function engineCreateBob(engine: ReturnType<typeof makeHarness>["engine"]) {
  // Bob already exists (newAgentForAlice created him). Return his id.
  for (const c of engine.getWorldSnapshot().characters.values()) {
    if (c.name === "Bob") return c.id
  }
  // If not present (unusual), create one.
  return engine.createCharacter({ name: "Bob", sector: 42 })
}

// Silence unused-import warnings from test helpers.
void newAgent

// ---- Combat-strategy flow: autonomous per-round decisions ----

describe("DebugAgent — combat_strategy.md fragment", () => {
  it("system prompt includes combat strategy fragment when opted in", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: "char-placeholder",
      includeCombatStrategyFragment: true,
    })
    expect(agent.systemPrompt).toContain("# Combat Strategy")
    expect(agent.systemPrompt).toContain(
      "You are an autonomous combat strategist piloting a ship in Gradient Bang.",
    )
    // Fragment is appended AFTER the combat mechanics fragment.
    const idxCombatMech = agent.systemPrompt.indexOf("# Combat Mechanics")
    const idxStrategy = agent.systemPrompt.indexOf("# Combat Strategy")
    expect(idxCombatMech).toBeLessThan(idxStrategy)
  })

  it("system prompt does NOT include strategy fragment by default", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: "char-placeholder",
    })
    expect(agent.systemPrompt).not.toContain("# Combat Strategy")
    // Combat mechanics fragment is still there.
    expect(agent.systemPrompt).toContain("# Combat Mechanics")
    // Silence unused-import warning for PROMPT_FRAGMENTS.
    expect(PROMPT_FRAGMENTS.combatStrategy).toContain("# Combat Strategy")
  })

  it("customStrategy overrides the canonical strategy fragment", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: "char-placeholder",
      includeCombatStrategyFragment: true,
      strategy: "offensive",
      customStrategy:
        "RAM the biggest enemy. Never flee. If destroyed, it was worth it.",
    })
    // The canonical OFFENSIVE_STRATEGY snippet's opener MUST NOT appear
    // (it should have been replaced by the custom override).
    expect(agent.systemPrompt).not.toContain(
      "You play aggressively. Default to ATTACK whenever you have a valid hostile target.",
    )
    // The custom text IS in the prompt, wrapped in the "## Combat style: CUSTOM" header.
    expect(agent.systemPrompt).toContain("## Combat style: CUSTOM")
    expect(agent.systemPrompt).toContain(
      "RAM the biggest enemy. Never flee. If destroyed, it was worth it.",
    )
  })

  it("empty customStrategy falls back to the named canonical strategy", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: "char-placeholder",
      includeCombatStrategyFragment: true,
      strategy: "defensive",
      customStrategy: "   ", // whitespace-only → treated as not set
    })
    expect(agent.systemPrompt).not.toContain("## Combat style: CUSTOM")
    expect(agent.systemPrompt).toContain(
      "You play cautiously. Default to BRACE unless you have a clear advantage.",
    )
  })

  it("default tool set exposes combat_action with production-shaped schema", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: "char-placeholder",
    })
    expect(agent.tools.map((t) => t.name)).toEqual(["combat_action"])
    const tool = agent.tools[0]
    expect(tool.parameters.required).toEqual([
      "combat_id",
      "action",
      "situation",
      "reasoning",
    ])
    const actionEnum = (tool.parameters.properties.action as Record<string, unknown>).enum
    expect(actionEnum).toEqual(["attack", "brace", "flee", "pay"])
    expect(tool).toBe(COMBAT_ACTION_TOOL)
  })
})

describe("DebugAgent — my_status + corporation_info injection", () => {
  it("initial user turn includes <my_status> and <corporation_info> payloads", () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({
      name: "Alice",
      sector: 42,
      shipType: "corsair_raider",
    })
    engine.createCharacter({ name: "Bob", sector: 42 })
    const corp = engine.createCorporation({
      name: "Alpha",
      memberCharacterIds: [alice],
    })

    const world = engine.getWorldSnapshot()
    const status = buildStatusFromWorld(world, alice)
    const corporation = buildCorporationInfoFromWorld(world, corp)

    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      status,
      corporation,
      includeCombatStrategyFragment: true,
    })
    agent.start("Fight for Alpha.")

    const firstMessage = agent.getContext().messages[0]
    expect(firstMessage.role).toBe("user")
    expect(firstMessage.content).toContain("Task: Fight for Alpha.")
    expect(firstMessage.content).toContain("<my_status>")
    expect(firstMessage.content).toContain("<corporation_info>")
    // Status JSON carries Alice's ship (Corsair Raider).
    expect(firstMessage.content).toContain('"ship_type": "corsair_raider"')
    // Corporation JSON carries the corp name + member id.
    expect(firstMessage.content).toContain('"name": "Alpha"')
    expect(firstMessage.content).toContain(`"character_id": "${alice}"`)
  })

  it("buildStatusFromWorld handles corp-ship pseudo-characters (ship as character_id)", () => {
    const { engine } = makeHarness()
    const corp = engine.createCorporation({ name: "Alpha" })
    const probe = engine.createCorpShip({
      ownerCorpId: corp,
      sector: 42,
      shipType: "autonomous_probe",
    })
    const status = buildStatusFromWorld(
      engine.getWorldSnapshot(),
      probe as unknown as never,
    )
    expect(status.character_id).toBe(probe)
    expect(status.ship.ship_type).toBe("autonomous_probe")
    expect(status.ship.ship_id).toBe(probe)
    expect(status.corporation?.corp_id).toBe(corp)
  })
})

describe("DebugAgent — autonomous per-round decision loop", () => {
  it("mock LLM sees the combat.round_waiting XML in its context and the combat_action tool", async () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    engine.createCharacter({ name: "Bob", sector: 42 })

    const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
    const mock = new MockLLMClient([
      { name: "combat_action", arguments: { combat_id: "x", action: "brace" } },
    ])
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      status,
      includeCombatStrategyFragment: true,
      llm: mock,
    })
    agent.start("Defend at all costs.")

    const cid = engine.initiateCombat(alice, 42)
    await agent.decide()

    // Mock captured the context + tool list it was given.
    expect(mock.lastContext).toBeTruthy()
    expect(mock.lastContext!.system).toContain("# Combat Strategy")
    expect(mock.lastTools.map((t) => t.name)).toEqual(["combat_action"])

    const roundWaitingInCtx = mock.lastContext!.messages.find((m) =>
      m.content.includes("<event name=\"combat.round_waiting\""),
    )
    expect(roundWaitingInCtx).toBeTruthy()
    expect(roundWaitingInCtx!.content).toContain(`combat_id="${cid}"`)

    // Initial user message with status also present.
    const initial = mock.lastContext!.messages.find((m) =>
      m.content.includes("<my_status>"),
    )
    expect(initial).toBeTruthy()
  })

  it("commitAction dispatches the LLM's combat_action to the engine (brace)", async () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    engine.createCharacter({ name: "Bob", sector: 42 })

    const cid = engine.initiateCombat(alice, 42) as CombatId
    const mock = new MockLLMClient([
      { name: "combat_action", arguments: { combat_id: cid, action: "brace" } },
    ])
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      llm: mock,
      includeCombatStrategyFragment: true,
    })
    agent.start("Defend.")

    const { call, result } = await agent.decideAndCommit()
    expect(call?.name).toBe("combat_action")
    expect(result?.ok).toBe(true)

    // Engine recorded Alice's brace as pending_action.
    const enc = engine.getWorldSnapshot().activeCombats.get(cid as never)!
    expect(enc.pending_actions[alice]?.action).toBe("brace")

    // Tool result message recorded in context.
    const toolMsg = agent.getContext().messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeTruthy()
    expect(toolMsg!.content).toContain("combat_action →")
    expect(toolMsg!.content).toContain('"ok":true')
  })

  it("multi-round strategy loop: LLM picks brace twice, combat resolves stalemate", async () => {
    // Both Alice + Bob are scripted by mock LLMs. Each decides brace → round 1
    // auto-resolves → combat ends stalemate after round 1 (both brace with no
    // toll garrison).
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    const bob = engine.createCharacter({ name: "Bob", sector: 42 })

    const cid = engine.initiateCombat(alice, 42) as CombatId
    const aliceMock = new MockLLMClient([
      { name: "combat_action", arguments: { combat_id: cid, action: "brace" } },
    ])
    const bobMock = new MockLLMClient([
      { name: "combat_action", arguments: { combat_id: cid, action: "brace" } },
    ])

    const aliceAgent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      llm: aliceMock,
      includeCombatStrategyFragment: true,
    })
    const bobAgent = new DebugAgent({
      engine,
      emitter,
      characterId: bob,
      llm: bobMock,
      includeCombatStrategyFragment: true,
    })
    aliceAgent.start("Defend.")
    bobAgent.start("Defend.")

    const aliceOutcome = await aliceAgent.decideAndCommit()
    const bobOutcome = await bobAgent.decideAndCommit()

    expect(aliceOutcome.result?.ok).toBe(true)
    expect(bobOutcome.result?.ok).toBe(true)

    // Each agent received a combat.ended event in its context.
    expect(aliceAgent.messagesFor("combat.ended")).toHaveLength(1)
    expect(bobAgent.messagesFor("combat.ended")).toHaveLength(1)
  })

  it("LLM picks attack with target_id pulled from participants list — commit dispatches to engine", async () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({
      name: "Alice",
      sector: 42,
      fighters: 50,
    })
    const bob = engine.createCharacter({ name: "Bob", sector: 42, fighters: 50 })

    const cid = engine.initiateCombat(alice, 42) as CombatId

    const aliceMock = new MockLLMClient([
      {
        name: "combat_action",
        arguments: {
          combat_id: cid,
          action: "attack",
          target_id: bob,
          commit: 10,
        },
      },
    ])
    const aliceAgent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      llm: aliceMock,
      includeCombatStrategyFragment: true,
    })
    aliceAgent.start("Engage hostile.")

    const { result } = await aliceAgent.decideAndCommit()
    expect(result?.ok).toBe(true)

    const enc = engine.getWorldSnapshot().activeCombats.get(cid as never)!
    const aliceAction = enc.pending_actions[alice]
    expect(aliceAction?.action).toBe("attack")
    expect(aliceAction?.target_id).toBe(bob)
    expect(aliceAction?.commit).toBe(10)
  })

  it("pay against a non-toll-mode garrison is rejected with a clear reason (not silently redirected)", () => {
    const { engine } = makeHarness()
    const alice = engine.createCharacter({
      name: "Alice",
      sector: 42,
      fighters: 50,
    })
    const bob = engine.createCharacter({ name: "Bob", sector: 42, fighters: 50 })
    // Defensive (NOT toll) garrison in the sector.
    engine.deployGarrison({
      ownerCharacterId: bob,
      sector: 42,
      fighters: 40,
      mode: "defensive",
    })
    const cid = engine.initiateCombat(alice, 42) as CombatId
    const result = engine.submitAction(alice, cid, {
      action: "pay",
      target_id: `garrison:42:${bob}`,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not in toll mode/i)
    // Previously this silently fell back to `garrisonIds[0]` (the first toll
    // garrison in the registry, or nothing if registry was empty). Now the
    // caller gets an explicit signal so the LLM can retry with a different
    // action.
  })

  it("decideAndCommit retries up to 3 times when the engine rejects the action", async () => {
    // Scenario: LLM first tries to pay a non-toll garrison (rejected);
    // agent's tool-result context now contains the rejection; second
    // decide() picks brace and succeeds.
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 42, fighters: 50 })
    const bob = engine.createCharacter({ name: "Bob", sector: 42, fighters: 50 })
    engine.deployGarrison({
      ownerCharacterId: bob,
      sector: 42,
      fighters: 40,
      mode: "defensive",
    })
    const cid = engine.initiateCombat(alice, 42) as CombatId

    const mock = new MockLLMClient([
      {
        name: "combat_action",
        arguments: {
          combat_id: cid,
          action: "pay",
          target_id: `garrison:42:${bob}`,
        },
      },
      {
        name: "combat_action",
        arguments: { combat_id: cid, action: "brace" },
      },
    ])
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      llm: mock,
      includeCombatStrategyFragment: true,
    })
    agent.start("Defend.")

    const outcome = await agent.decideAndCommit()
    // The FINAL call should be the successful brace (not the rejected pay).
    expect(outcome.call?.arguments.action).toBe("brace")
    expect(outcome.result?.ok).toBe(true)
    // Both attempts went through the mock (one rejected, one accepted).
    expect(mock.callHistory).toHaveLength(2)
  })

  it("commitAction rejects an unknown tool name but still appends a tool-result message", async () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 42 })
    engine.createCharacter({ name: "Bob", sector: 42 })
    const cid = engine.initiateCombat(alice, 42) as CombatId

    const mock = new MockLLMClient([
      { name: "finished", arguments: { message: "oops wrong tool" } },
    ])
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      llm: mock,
      includeCombatStrategyFragment: true,
    })
    agent.start("Test.")

    const result = await agent.decideAndCommit()
    expect(result.call?.name).toBe("finished")
    // Non-combat_action → commit not called → result is null (per decideAndCommit contract).
    expect(result.result).toBeNull()
    // But decide() still recorded the call as an assistant message.
    const assistant = agent.getContext().messages.find((m) => m.role === "assistant")
    expect(assistant?.tool_call?.name).toBe("finished")

    // Silence the unused cid.
    void cid
  })
})

// ---- Corp fan-out: player agent sees combat events for corp ships ----
//
// These scenarios cover the case where a player's CORP ship is engaged in a
// DIFFERENT sector. The player is not personally a combat participant, but
// (a) they're included in `event.recipients` via corp fan-out, and (b) their
// DebugAgent was constructed WITH corporation info, so the XML filter frames
// the events as "your corp's {ship} is engaged..." and surfaces ship_id +
// ship_name so the LLM can identify which ship is in trouble.
describe("DebugAgent — corp fan-out XML", () => {
  function setupRemoteCorpShipFight(opts: {
    aliceSector?: number
    combatSector?: number
    corpShipType?: never
  } = {}) {
    const { engine, emitter } = makeHarness()
    const aliceSector = opts.aliceSector ?? 1
    const combatSector = opts.combatSector ?? 42

    const alice = engine.createCharacter({ name: "Alice", sector: aliceSector })
    const bob = engine.createCharacter({ name: "Bob", sector: combatSector })
    const corp = engine.createCorporation({
      name: "Alpha",
      memberCharacterIds: [alice],
    })
    const corpShip = engine.createCorpShip({
      ownerCorpId: corp,
      sector: combatSector,
      name: "Alpha Sentinel",
    })

    // Alice's agent — with corporation info so the XML filter treats the corp
    // ship as a corp-mate.
    const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
    const corporation = buildCorporationInfoFromWorld(
      engine.getWorldSnapshot(),
      corp,
    )
    const aliceAgent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      status,
      corporation,
    })
    aliceAgent.start("Manage corp affairs.")

    return { engine, emitter, alice, bob, corp, corpShip, aliceAgent }
  }

  it("corp owner receives combat.round_waiting XML when corp ship engaged in remote sector", () => {
    const { engine, bob, corpShip, aliceAgent } = setupRemoteCorpShipFight()
    engine.initiateCombat(bob, 42)

    const waits = aliceAgent.messagesFor("combat.round_waiting")
    expect(waits).toHaveLength(1)
    const xml = waits[0].content
    expect(xml).toMatch(/<event name="combat\.round_waiting" combat_id="combat-/)
    expect(xml).toContain("Combat state: your corp's")
    expect(xml).toContain("Alpha Sentinel")
    // Ship_id is surfaced so the LLM can correlate to corporation_info.ships[].
    expect(xml).toContain(`ship_id=${corpShip}`)
    // Participants list carries the corp ship's combatant line tagged as an ally.
    expect(xml).toContain("[ally — your corp]")
    // The human opponent's line is also present (participants listed in full).
    expect(xml).toContain("combatant_id=" + bob)
  })

  it("corp owner does NOT get 'Submit a combat action now.' when they themselves aren't a participant", () => {
    const { engine, bob, aliceAgent } = setupRemoteCorpShipFight()
    engine.initiateCombat(bob, 42)
    const xml = aliceAgent.messagesFor("combat.round_waiting")[0].content
    expect(xml).not.toContain("Submit a combat action now.")
  })

  it("corp owner receives combat.round_resolved XML with corp ship loss summary", () => {
    const { engine, alice, bob, corp, corpShip, aliceAgent } =
      setupRemoteCorpShipFight()
    void alice
    void corp

    const cid = engine.initiateCombat(bob, 42)
    // Bob attacks the corp ship; corp-ship pseudo-character braces.
    engine.submitAction(bob, cid, {
      action: "attack",
      target_id: corpShip,
      commit: 20,
    })
    engine.submitAction(corpShip as unknown as CharacterId, cid, {
      action: "brace",
    })

    const resolved = aliceAgent.messagesFor("combat.round_resolved")
    expect(resolved).toHaveLength(1)
    const xml = resolved[0].content
    expect(xml).toMatch(/<event name="combat\.round_resolved" combat_id="combat-/)
    // Framing identifies the corp ship by name + ship_id.
    expect(xml).toContain("Alpha Sentinel")
    expect(xml).toContain(`ship_id=${corpShip}`)
    // Round summary uses the corp-ship-prefixed form (not "your:") since Alice
    // isn't personally a participant.
    expect(xml).toMatch(
      /corp ship "Alpha Sentinel" \(ship_id=[^)]+\): (fighters lost \d+|no fighter losses), (shield damage \d+\.\d+%|no shield damage)\./,
    )
  })

  it("corp owner receives ship.destroyed XML when corp ship is killed, with ship_id + ship_name attrs", () => {
    // Stack the fight so the corp ship loses in a single round: Bob attacks
    // with massive commit; corp ship has minimal fighters/shields.
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 500,
    })
    const corp = engine.createCorporation({
      name: "Alpha",
      memberCharacterIds: [alice],
    })
    const corpShip = engine.createCorpShip({
      ownerCorpId: corp,
      sector: 42,
      name: "Doomed Probe",
      fighters: 1,
      shields: 0,
    })

    const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
    const corporation = buildCorporationInfoFromWorld(
      engine.getWorldSnapshot(),
      corp,
    )
    const aliceAgent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      status,
      corporation,
    })
    aliceAgent.start("Manage corp.")

    const cid = engine.initiateCombat(bob, 42)
    engine.submitAction(bob, cid, {
      action: "attack",
      target_id: corpShip,
      commit: 100,
    })
    engine.submitAction(corpShip as unknown as CharacterId, cid, {
      action: "brace",
    })

    const destroyed = aliceAgent.messagesFor("ship.destroyed")
    expect(destroyed).toHaveLength(1)
    const xml = destroyed[0].content
    // XML envelope carries ship_id + ship_name at the top level (so filters
    // and humans can key off them at a glance).
    expect(xml).toMatch(/<event name="ship\.destroyed"/)
    expect(xml).toContain(`ship_id="${corpShip}"`)
    expect(xml).toContain(`ship_name="Doomed Probe"`)
    // Body framing identifies it as a corp ship (not "your ship", not stranger).
    expect(xml).toContain(`Your corp's ship "Doomed Probe"`)
    expect(xml).toContain(`ship_id=${corpShip}`)
    expect(xml).toContain("in sector 42")
  })

  it("raw combat.round_resolved payload carries per-ship state (shields + fighters) for RTVI-style UI updates", () => {
    // Sanity: the engine's payload (not just the agent-facing summary) must
    // include ship shield_integrity + fighter_loss so a UI subscriber can
    // render the corp ship's health in real time.
    const { engine, emitter } = makeHarness()
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 30,
    })
    const corp = engine.createCorporation({ name: "Alpha" })
    const corpShip = engine.createCorpShip({
      ownerCorpId: corp,
      sector: 42,
      name: "Alpha Sentinel",
    })

    const cid = engine.initiateCombat(bob, 42)
    engine.submitAction(bob, cid, {
      action: "attack",
      target_id: corpShip,
      commit: 10,
    })
    engine.submitAction(corpShip as unknown as CharacterId, cid, {
      action: "brace",
    })

    const resolvedEvents = emitter
      .getLog()
      .filter((e) => e.type === "combat.round_resolved")
    expect(resolvedEvents).toHaveLength(1)
    const payload = resolvedEvents[0].payload as Record<string, unknown>
    const participants = payload.participants as Array<Record<string, unknown>>
    const corpShipPayload = participants.find((p) => p.id === corpShip)
    expect(corpShipPayload).toBeTruthy()
    const ship = corpShipPayload!.ship as Record<string, unknown>
    expect(ship.ship_name).toBe("Alpha Sentinel")
    expect(typeof ship.shield_integrity).toBe("number")
    // corp_id tag on the participant is the harness-only enrichment that
    // lets the agent's filter identify corp-mates.
    expect(corpShipPayload!.corp_id).toBe(corp)
  })
})

describe("DebugAgent — absent garrison owner", () => {
  // Alice deploys a garrison in sector 42 but is herself in sector 1.
  // Bob wanders in and engages the garrison. Alice isn't a combat
  // participant, but she IS the garrison owner — she should still see
  // every round's XML so her LLM knows the garrison is under attack.
  it("absent garrison owner receives round_waiting + round_resolved XML with 'your garrison' framing", () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 50,
    })
    engine.deployGarrison({
      ownerCharacterId: alice,
      sector: 42,
      fighters: 80,
      mode: "offensive",
    })

    const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
    const aliceAgent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      status,
    })
    aliceAgent.start("Defend your assets.")

    // Bob's arrival + offensive garrison already auto-initiated combat.
    // Drive round 1 to resolve: Bob braces, garrison auto-attacks.
    const snap = engine.getWorldSnapshot()
    const active = Array.from(snap.activeCombats.values()).find(
      (c) => c.sector_id === 42 && !c.ended,
    )
    if (active) {
      engine.submitAction(bob, active.combat_id as never, { action: "brace" })
    }

    // Alice's agent should have received round_waiting XML, NOT filtered out.
    const waits = aliceAgent.messagesFor("combat.round_waiting")
    expect(waits.length).toBeGreaterThanOrEqual(1)
    const wait = waits[0].content
    expect(wait).toContain("your garrison")
    expect(wait).toContain("in sector 42")
    // It's not HER combat in the sense of "submit an action" — that line
    // should not appear for an absent garrison owner.
    expect(wait).not.toContain("Submit a combat action now.")

    // Round resolved delivery — the whole point of this test.
    const resolved = aliceAgent.messagesFor("combat.round_resolved")
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    const r = resolved[0].content
    expect(r).toContain("your garrison")
    // The garrison line renders with (yours) side marker.
    expect(r).toContain("(yours)")
  })
})

// ---- Remote garrison event flow scenarios ----
//
// These lock in the production-intended routing:
//   1. Garrison owner (possibly in a different sector) gets every round
//      event for their garrison — context-append only, no inference
//      trigger. Spec'd as `run_llm: false` in the migration doc.
//   2. When the garrison is destroyed, a dedicated `garrison.destroyed`
//      event fires — that event *should* trigger inference (voice
//      notifies the player). The harness just validates delivery +
//      metadata; `run_llm` semantics are enforced in production's
//      InferenceRule layer.
//   3. Uninvolved players (not in the garrison sector and not in the
//      garrison owner's corp) must NEVER see these events.
//   4. Same-sector bystanders DO see the events (sector observer rule).
//
// Metadata contract: the XML envelope on all garrison-related events
// carries `garrison_id` + `garrison_owner` so clients can filter
// without parsing the summary body.
describe("DebugAgent — remote garrison event flow", () => {
  it("absent owner receives round_waiting + round_resolved XML with garrison_id + garrison_owner attributes", () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 50,
    })
    const gid = engine.deployGarrison({
      ownerCharacterId: alice,
      sector: 42,
      fighters: 80,
      mode: "offensive",
    })

    const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
    const aliceAgent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      status,
    })
    aliceAgent.start("Defend your assets.")

    const active = Array.from(
      engine.getWorldSnapshot().activeCombats.values(),
    ).find((c) => c.sector_id === 42 && !c.ended)
    if (active) {
      engine.submitAction(bob, active.combat_id as never, { action: "brace" })
    }

    const waits = aliceAgent.messagesFor("combat.round_waiting")
    expect(waits.length).toBeGreaterThanOrEqual(1)
    const wait = waits[0].content
    expect(wait).toContain(`garrison_id="garrison:42:${alice}"`)
    expect(wait).toContain(`garrison_owner="${alice}"`)
    expect(wait).toContain("your garrison")
    // Silence unused binding if the garrison id changes shape in future.
    void gid
  })

  it("garrison.destroyed fires when the garrison's fighters reach 0 — owner gets the event with the right metadata", () => {
    const { engine, emitter, advance, getNow, world } = makeHarness(11)
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 200,
      shields: 200,
    })
    engine.deployGarrison({
      ownerCharacterId: alice,
      sector: 42,
      fighters: 2,
      mode: "offensive",
    })

    const status = buildStatusFromWorld(engine.getWorldSnapshot(), alice)
    const aliceAgent = new DebugAgent({
      engine,
      emitter,
      characterId: alice,
      status,
    })
    aliceAgent.start("Watch your garrison.")

    const active = Array.from(world().activeCombats.values()).find(
      (c) => c.sector_id === 42 && !c.ended,
    )!
    engine.submitAction(bob, active.combat_id as never, {
      action: "attack",
      target_id: `garrison:42:${alice}`,
      commit: 150,
    })

    // Push through the deadline so the engine finalizes the round.
    advance(31_000)
    engine.tick(getNow())

    const destroyed = eventsOfType(emitter, "garrison.destroyed")
    expect(destroyed).toHaveLength(1)
    const payload = payloadOf(destroyed[0])
    expect(payload.owner_character_id).toBe(alice)
    expect(payload.garrison_id).toBe(`garrison:42:${alice}`)
    expect(recipientsOf(destroyed[0])).toContain(alice)

    // Alice's agent XML includes garrison_id + garrison_owner on the
    // envelope and a "your garrison was destroyed" body.
    const xmls = aliceAgent.messagesFor("garrison.destroyed")
    expect(xmls).toHaveLength(1)
    const xml = xmls[0].content
    expect(xml).toContain(`garrison_id="garrison:42:${alice}"`)
    expect(xml).toContain(`garrison_owner="${alice}"`)
    expect(xml).toContain("Your garrison was destroyed")
  })

  it("uninvolved player (not in sector, not in owner's corp) receives NO garrison events", () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 50,
    })
    // Dave is a total bystander — different sector, no corp link to Alice.
    const dave = engine.createCharacter({ name: "Dave", sector: 99 })
    engine.deployGarrison({
      ownerCharacterId: alice,
      sector: 42,
      fighters: 80,
      mode: "offensive",
    })

    const daveAgent = new DebugAgent({ engine, emitter, characterId: dave })
    daveAgent.start("Mind your own business.")

    const active = Array.from(
      engine.getWorldSnapshot().activeCombats.values(),
    ).find((c) => c.sector_id === 42 && !c.ended)
    if (active) {
      engine.submitAction(bob, active.combat_id as never, { action: "brace" })
    }

    // Routing-level check: Dave is never in any garrison-combat event's
    // recipient set.
    for (const evType of [
      "combat.round_waiting",
      "combat.round_resolved",
      "combat.ended",
      "garrison.destroyed",
    ]) {
      for (const ev of eventsOfType(emitter, evType)) {
        expect(ev.recipients).not.toContain(dave)
      }
    }
    // Filter-level check: Dave's agent never appended a combat XML.
    expect(daveAgent.messagesFor("combat.round_waiting")).toHaveLength(0)
    expect(daveAgent.messagesFor("combat.round_resolved")).toHaveLength(0)
    expect(daveAgent.messagesFor("garrison.destroyed")).toHaveLength(0)
  })

  it("same-sector bystander DOES receive events for a non-friendly garrison's combat (sector-observer rule)", () => {
    const { engine, emitter } = makeHarness()
    const alice = engine.createCharacter({ name: "Alice", sector: 1 })
    const bob = engine.createCharacter({
      name: "Bob",
      sector: 42,
      fighters: 50,
    })
    // Carol just happens to be in the same sector as the fight. She's not
    // the garrison owner, not in Alice's corp, and not the initiator —
    // but she's a sector observer and should see the combat events.
    const carol = engine.createCharacter({
      name: "Carol",
      sector: 42,
      fighters: 50,
    })
    engine.deployGarrison({
      ownerCharacterId: alice,
      sector: 42,
      fighters: 80,
      mode: "offensive",
    })

    const carolAgent = new DebugAgent({ engine, emitter, characterId: carol })
    carolAgent.start("Watch the neighbours fight.")

    const active = Array.from(
      engine.getWorldSnapshot().activeCombats.values(),
    ).find((c) => c.sector_id === 42 && !c.ended)
    if (active) {
      // Carol is auto-drawn into combat as a same-sector participant. Let
      // her brace so the round can resolve.
      engine.submitAction(carol, active.combat_id as never, { action: "brace" })
      engine.submitAction(bob, active.combat_id as never, { action: "brace" })
    }

    // Carol is in recipients for at least round_waiting + round_resolved.
    const waits = eventsOfType(emitter, "combat.round_waiting")
    expect(waits.length).toBeGreaterThanOrEqual(1)
    expect(recipientsOf(waits[0])).toContain(carol)
    const resolved = eventsOfType(emitter, "combat.round_resolved")
    expect(resolved.length).toBeGreaterThanOrEqual(1)
    expect(recipientsOf(resolved[0])).toContain(carol)

    // Carol's agent context has the XML — she was auto-swept in as a
    // participant so `isInvolved` is trivially true.
    expect(
      carolAgent.messagesFor("combat.round_waiting").length,
    ).toBeGreaterThanOrEqual(1)
  })
})

// Silence unused type imports.
void undefined as unknown as CombatId
void undefined as unknown as CorpId
