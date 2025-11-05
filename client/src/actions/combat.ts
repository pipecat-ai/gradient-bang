export const COMBAT_ACTION = "combat-action";

export const composeCombatAction = (action: CombatAction) => {
  return {
    type: COMBAT_ACTION,
    payload: action,
  };
};
