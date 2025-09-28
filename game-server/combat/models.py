"""Data models for the combat subsystem."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Literal, Optional, Union, cast

ActionName = Literal["attack", "brace", "flee"]
CombatantType = Literal["character", "garrison"]
GarrisonMode = Literal["offensive", "defensive", "toll"]


class CombatantAction(Enum):
    """Supported per-round actions for a combatant."""

    ATTACK = "attack"
    BRACE = "brace"
    FLEE = "flee"

    @classmethod
    def from_str(cls, value: str) -> "CombatantAction":
        try:
            return cls(value.lower())
        except ValueError as exc:
            raise ValueError(f"Unknown combat action: {value}") from exc


@dataclass
class CombatantState:
    """Mutable state tracked for each participant in an encounter."""

    combatant_id: str
    combatant_type: CombatantType
    name: str
    fighters: int
    shields: int
    turns_per_warp: int
    max_fighters: int
    max_shields: int
    is_escape_pod: bool = False
    owner_character_id: Optional[str] = None

    def mitigation(self) -> float:
        """Return shield mitigation percentage (0.0-0.5)."""
        base = max(0.0, min(0.5, 0.0005 * max(0, self.shields)))
        return base


@dataclass
class RoundAction:
    """Submitted action for a single combatant."""

    action: CombatantAction
    commit: int = 0
    submitted_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    timed_out: bool = False
    target_id: Optional[str] = None
    destination_sector: Optional[int] = None


@dataclass
class CombatRoundLog:
    """Log record for a resolved round."""

    round_number: int
    actions: Dict[str, RoundAction]
    hits: Dict[str, int]
    offensive_losses: Dict[str, int]
    defensive_losses: Dict[str, int]
    shield_loss: Dict[str, int]
    result: Optional[str]
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class CombatRoundOutcome:
    """Aggregated outcome information returned from the engine."""

    round_number: int
    hits: Dict[str, int]
    offensive_losses: Dict[str, int]
    defensive_losses: Dict[str, int]
    shield_loss: Dict[str, int]
    fighters_remaining: Dict[str, int]
    shields_remaining: Dict[str, int]
    flee_results: Dict[str, bool]
    end_state: Optional[str]
    effective_actions: Dict[str, RoundAction]


@dataclass
class CombatEncounter:
    """Represents an active combat between up to two combatants."""

    combat_id: str
    sector_id: int
    participants: Dict[str, CombatantState]
    round_number: int = 1
    deadline: Optional[datetime] = None
    base_seed: Optional[int] = None
    logs: List[CombatRoundLog] = field(default_factory=list)
    pending_actions: Dict[str, RoundAction] = field(default_factory=dict)
    awaiting_resolution: bool = False
    ended: bool = False
    end_state: Optional[str] = None
    context: Dict[str, object] = field(default_factory=dict)

    def other_combatant(self, combatant_id: str) -> Optional[CombatantState]:
        for cid, state in self.participants.items():
            if cid != combatant_id:
                return state
        return None


@dataclass
class GarrisonState:
    """Persisted representation of fighters stationed in a sector."""

    owner_id: str
    fighters: int
    mode: GarrisonMode
    toll_amount: int = 0
    deployed_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> Dict[str, Union[str, int]]:
        return {
            "owner_id": self.owner_id,
            "fighters": self.fighters,
            "mode": self.mode,
            "toll_amount": self.toll_amount,
            "deployed_at": self.deployed_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Union[str, int]]) -> "GarrisonState":
        return cls(
            owner_id=str(data.get("owner_id")),
            fighters=int(data.get("fighters", 0)),
            mode=cls._parse_mode(data.get("mode")),
            toll_amount=int(data.get("toll_amount", 0)),
            deployed_at=str(data.get("deployed_at") or datetime.now(timezone.utc).isoformat()),
        )

    @staticmethod
    def _parse_mode(mode: Optional[Union[str, GarrisonMode]]) -> GarrisonMode:
        if isinstance(mode, str):
            value = mode.lower()
        else:
            value = str(mode)
        if value not in ("offensive", "defensive", "toll"):
            raise ValueError(f"Invalid garrison mode: {mode}")
        return cast(GarrisonMode, value)
