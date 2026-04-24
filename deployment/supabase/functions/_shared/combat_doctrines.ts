// Combat-strategy doctrine text for edge functions.
//
// Deno mirror of the Python prompt fragments at
//   src/gradientbang/prompts/fragments/strategies/{balanced,offensive,defensive}.md
// Keep the two in sync when editing — the Python relay loads the .md files
// for LLM-context preamble injection, while these constants feed the
// RTVI/API responses so clients can display the active doctrine without a
// separate fetch.

export const BALANCED_DOCTRINE = `# Strategy: Balanced

Read the situation every round and adapt. No default bias toward attack or brace — let the numbers decide.

## Decision priorities

1. **If outnumbered in fighters AND shields are damaged** → BRACE to rebuild, probe with small commits next round.
2. **If opponents are visibly weaker** (lower fighters, lower shields) → ATTACK with a commit sized to the hit-chance read.
3. **If warp agility advantage is clear AND fighters are depleted** → FLEE.
4. **If toll garrison is the only hostile AND pay is affordable** → PAY.
5. **Otherwise** → BRACE.

## Commit sizing
Match commit to current hit-chance estimate. Never commit more fighters than you're willing to lose on a miss streak.
`;

export const OFFENSIVE_DOCTRINE = `# Strategy: Offensive

Commit fighters aggressively. Favor ATTACK over every other action. Only flee when near-dead.

## Decision priorities

1. **Default: ATTACK.** Pick the weakest hostile target (lowest fighters, lowest shields). Commit heavily.
2. **If your fighters are below 10% of starting count AND you have warp advantage** → FLEE as last resort.
3. **If a toll garrison is the only hostile AND payment is clearly cheaper than committing fighters to finish it** → PAY.
4. **Avoid BRACE** unless you literally have no valid target this round.

## Commit sizing
Commit at least half your current fighters on a weak target. Against equal or stronger opponents, commit aggressively enough to force the issue — this doctrine accepts fighter losses as a cost of winning fast.
`;

export const DEFENSIVE_DOCTRINE = `# Strategy: Defensive

Preserve fighters and shields. BRACE by default. Attack only with clear advantage. Retreat early when cornered.

## Decision priorities

1. **Default: BRACE.** Rebuild shields and force opponents to waste fighters on you.
2. **If you have clear fighter AND shield advantage over a specific target** → ATTACK with a small-to-moderate commit. Probe, don't overextend.
3. **If fighters drop below 40% of starting count OR shields are below 30%** → FLEE toward a safe adjacent sector. Don't wait for depletion.
4. **If a toll garrison demands payment AND you can afford it** → PAY immediately. Avoid grinding through toll combat.

## Commit sizing
When you do attack, size commits conservatively — no more than 25% of current fighters per round. A miss streak shouldn't threaten survival.
`;

export type CombatStrategyTemplate = "balanced" | "offensive" | "defensive";

export const DEFAULT_STRATEGY_TEMPLATE: CombatStrategyTemplate = "balanced";

const DOCTRINES: Record<CombatStrategyTemplate, string> = {
  balanced: BALANCED_DOCTRINE,
  offensive: OFFENSIVE_DOCTRINE,
  defensive: DEFENSIVE_DOCTRINE,
};

export function getDoctrineText(template: CombatStrategyTemplate): string {
  return DOCTRINES[template];
}

export function isValidTemplate(value: unknown): value is CombatStrategyTemplate {
  return value === "balanced" || value === "offensive" || value === "defensive";
}
