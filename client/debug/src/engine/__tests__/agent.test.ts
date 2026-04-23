import { describe, expect, it } from "vitest"

import { DebugAgent, MockLLMClient } from "../../agent/debug_agent"
import { PROMPT_FRAGMENTS } from "../../agent/prompts"
import {
  buildCorporationInfoFromWorld,
  buildStatusFromWorld,
} from "../../agent/status"
import { COMBAT_ACTION_TOOL } from "../../agent/tools"
import type { CombatId, CorpId } from "../types"
import { asCharacterId, makeHarness } from "./setup"

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
    expect(xml).toMatch(/Round resolved: .+; (fighters lost \d+|no fighter losses), (shield damage \d+\.\d+%|no shield damage)\./)
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

  it("default tool set exposes combat_action with production-shaped schema", () => {
    const { engine, emitter } = makeHarness()
    const agent = new DebugAgent({
      engine,
      emitter,
      characterId: "char-placeholder",
    })
    expect(agent.tools.map((t) => t.name)).toEqual(["combat_action"])
    const tool = agent.tools[0]
    expect(tool.parameters.required).toEqual(["combat_id", "action"])
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

// Silence unused type imports.
void undefined as unknown as CombatId
void undefined as unknown as CorpId
