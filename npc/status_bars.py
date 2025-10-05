"""
Status bar data structures and updater for combat TUI.

Provides a clean interface for managing all status bar state,
updating from server events, and formatting for display.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
from datetime import datetime


@dataclass
class ShipInfo:
    """Info about a ship in the sector (non-combat)"""
    name: str
    ship_type: str


@dataclass
class GarrisonInfo:
    """Info about garrison in sector"""
    owner_name: str
    fighters: int
    mode: str  # "offensive", "defensive", "toll"
    toll_amount: Optional[int] = None


@dataclass
class PortInfo:
    """Info about port in sector"""
    port_type: str
    stock: Dict[str, int] = field(default_factory=dict)
    prices: Dict[str, int] = field(default_factory=dict)


@dataclass
class CombatantStatus:
    """Detailed combat participant status"""
    combatant_id: str
    name: str
    ship_type: Optional[str]  # None for garrisons
    fighters: int
    shields: int
    max_fighters: int
    max_shields: int
    is_escape_pod: bool
    fighters_delta: int = 0
    shields_delta: int = 0
    last_action: Optional[str] = None  # "attack→bob(10)", "brace", "flee→3253"


@dataclass
class CargoInfo:
    fuel_ore: int = 0
    organics: int = 0
    equipment: int = 0


@dataclass
class StatusBarState:
    """Complete state for rendering all status bars"""
    # Bar 1: Sector and combat state
    sector_id: int = 0
    combat_state: str = "quiet"  # "quiet", "in_combat", "waiting_round_1", etc.
    adjacent_sectors: List[int] = field(default_factory=list)

    # Bar 2: Ship status
    credits: int = 0
    fighters: int = 0
    shields: int = 0
    max_fighters: int = 0
    max_shields: int = 0
    cargo: CargoInfo = field(default_factory=CargoInfo)
    warp_power: int = 0
    max_warp_power: int = 0

    # Bar 3: Other ships in sector
    ships: List[ShipInfo] = field(default_factory=list)

    # Bar 4: Garrison
    garrison: Optional[GarrisonInfo] = None

    # Bar 5: Port
    port: Optional[PortInfo] = None

    # Bars 6+: Combat participants (only when in combat)
    combat_participants: Dict[str, CombatantStatus] = field(default_factory=dict)

    # Combat metadata
    in_combat: bool = False
    combat_id: Optional[str] = None
    current_round: int = 0
    deadline: Optional[datetime] = None

    def is_combat_active(self) -> bool:
        """Check if we're in active combat"""
        return self.in_combat and self.combat_id is not None


class StatusBarUpdater:
    """
    Manages status bar state and updates from server events.
    Single source of truth for UI rendering.
    """

    def __init__(self, character_id: str):
        self.character_id = character_id
        self.state = StatusBarState()

    def update_from_status(self, status_payload: dict) -> None:
        """Update from status.update event"""
        # Bar 1: Sector
        self.state.sector_id = status_payload.get("sector", 0)

        # Get adjacent sectors from sector_contents
        sector_contents = status_payload.get("sector_contents", {})
        self.state.adjacent_sectors = sector_contents.get("adjacent_sectors", [])

        # Bar 2: Ship stats
        ship = status_payload.get("ship", {})
        self.state.credits = ship.get("credits", 0)
        self.state.fighters = ship.get("fighters", 0)
        self.state.shields = ship.get("shields", 0)
        self.state.max_fighters = ship.get("max_fighters", 0)
        self.state.max_shields = ship.get("max_shields", 0)
        self.state.warp_power = ship.get("warp_power", 0)
        self.state.max_warp_power = ship.get("max_warp_power", 0)

        cargo = ship.get("cargo", {})
        self.state.cargo = CargoInfo(
            fuel_ore=cargo.get("fuel_ore", 0),
            organics=cargo.get("organics", 0),
            equipment=cargo.get("equipment", 0)
        )

        # Bar 3: Ships in sector
        sector_contents = status_payload.get("sector_contents", {})
        self.state.ships = [
            ShipInfo(name=c["name"], ship_type=c.get("ship_type", "unknown"))
            for c in sector_contents.get("other_players", [])
        ]

        # Bar 4: Garrison
        garrison_data = sector_contents.get("garrison")
        if garrison_data:
            self.state.garrison = GarrisonInfo(
                owner_name=garrison_data["owner_id"],
                fighters=garrison_data["fighters"],
                mode=garrison_data["mode"],
                toll_amount=garrison_data.get("toll_amount")
            )
        else:
            self.state.garrison = None

        # Bar 5: Port
        port_data = sector_contents.get("port")
        if port_data:
            self.state.port = PortInfo(
                port_type=port_data.get("code", "unknown"),
                stock=port_data.get("last_seen_stock", {}),
                prices=port_data.get("last_seen_prices", {})
            )
        else:
            self.state.port = None

    def update_from_combat_started(self, payload: dict) -> None:
        """Update from combat.started event"""
        self.state.in_combat = True
        self.state.combat_id = payload["combat_id"]
        self.state.current_round = payload["round"]
        self.state.combat_state = f"combat_round_{payload['round']}"
        deadline_str = payload["deadline"]
        if deadline_str:
            self.state.deadline = datetime.fromisoformat(deadline_str.replace("Z", "+00:00"))

        # Initialize combat participants (no deltas yet, no actions yet)
        participants = payload.get("participants", {})
        self._update_combat_participants(participants, {})

    def update_from_combat_round_waiting(self, payload: dict) -> None:
        """Update from combat.round_waiting event"""
        self.state.current_round = payload["round"]
        self.state.combat_state = f"waiting_round_{payload['round']}"
        deadline_str = payload["deadline"]
        if deadline_str:
            self.state.deadline = datetime.fromisoformat(deadline_str.replace("Z", "+00:00"))

        # Update participants (may have changed due to flee/defeat)
        participants = payload.get("participants", {})
        self._update_combat_participants(participants, {})

    def update_from_combat_round_resolved(self, payload: dict) -> None:
        """Update from combat.round_resolved event"""
        self.state.combat_state = f"resolved_round_{payload['round']}"

        # Update participants with deltas and actions
        participants = payload.get("participants", {})
        actions = payload.get("actions", {})

        self._update_combat_participants(participants, actions)

    def update_from_combat_ended(self, payload: dict) -> None:
        """Update from combat.ended event"""
        self.state.in_combat = False
        self.state.combat_state = "quiet"
        self.state.combat_id = None
        self.state.current_round = 0
        self.state.deadline = None
        self.state.combat_participants.clear()

    def _update_combat_participants(
        self,
        participants: dict,
        actions: dict
    ) -> None:
        """Helper to update combat participant details"""
        # Preserve existing deltas when updating (for round_waiting events)
        old_deltas = {}
        for pid, old_combatant in self.state.combat_participants.items():
            old_deltas[pid] = (old_combatant.fighters_delta, old_combatant.shields_delta)

        self.state.combat_participants.clear()

        for pid, p in participants.items():
            # Skip escape pods
            if p.get("is_escape_pod", False):
                continue

            # Format action string
            action_str = None
            if pid in actions:
                action = actions[pid]
                action_type = action.get("action", "timeout")
                if action_type == "attack":
                    target = action.get("target_id", "?")
                    commit = action.get("commit", 0)
                    action_str = f"attack→{target}({commit})"
                elif action_type == "flee":
                    dest = action.get("destination_sector", "?")
                    action_str = f"flee→{dest}"
                elif action_type == "pay":
                    target = action.get("target", "?")
                    action_str = f"pay→{target}"
                else:
                    action_str = action_type  # "brace" or other

            # Get deltas: use from payload if present, otherwise preserve old deltas
            if "fighters_delta" in p or "shields_delta" in p:
                fighters_delta = p.get("fighters_delta", 0)
                shields_delta = p.get("shields_delta", 0)
            else:
                # Preserve deltas from previous state
                fighters_delta, shields_delta = old_deltas.get(pid, (0, 0))

            self.state.combat_participants[pid] = CombatantStatus(
                combatant_id=pid,
                name=p["name"],
                ship_type=p.get("ship_type"),
                fighters=p["fighters"],
                shields=p["shields"],
                max_fighters=p["max_fighters"],
                max_shields=p["max_shields"],
                is_escape_pod=p.get("is_escape_pod", False),
                fighters_delta=fighters_delta,
                shields_delta=shields_delta,
                last_action=action_str
            )

    def format_status_bars(self) -> List[str]:
        """
        Generate list of formatted status bar strings for display.
        Returns list of strings, one per status bar.
        """
        lines = []

        # Bar 1: Sector and combat state
        adjacent_str = f" | [{', '.join(map(str, sorted(self.state.adjacent_sectors)))}]" if self.state.adjacent_sectors else ""
        lines.append(f"sector {self.state.sector_id} | {self.state.combat_state}{adjacent_str}")

        # Bar 2: Ship status
        lines.append(
            f"credits: {self.state.credits} | "
            f"fighters: {self.state.fighters}/{self.state.max_fighters} "
            f"shields: {self.state.shields}/{self.state.max_shields} | "
            f"cargo FO:{self.state.cargo.fuel_ore} "
            f"OG:{self.state.cargo.organics} "
            f"EQ:{self.state.cargo.equipment} | "
            f"warp {self.state.warp_power}/{self.state.max_warp_power}"
        )

        # Bar 3: Ships in sector
        if self.state.ships:
            ship_list = ", ".join(f"{s.name} ({s.ship_type})" for s in self.state.ships)
            lines.append(f"ships | {ship_list}")
        else:
            lines.append("ships | none")

        # Bar 4: Garrison
        if self.state.garrison:
            g = self.state.garrison
            if g.mode == "toll" and g.toll_amount:
                lines.append(f"garrison | {g.owner_name}:{g.fighters}({g.mode}, toll={g.toll_amount})")
            else:
                lines.append(f"garrison | {g.owner_name}:{g.fighters}({g.mode})")
        else:
            lines.append("garrison | none")

        # Bar 5: Port
        if self.state.port:
            p = self.state.port
            # Format: FO:700@24 OG:300@12 EQ:300@49
            goods = []
            for commodity, short in [("fuel_ore", "FO"), ("organics", "OG"), ("equipment", "EQ")]:
                stock = p.stock.get(commodity)
                price = p.prices.get(commodity)
                if stock is not None and price is not None:
                    goods.append(f"{short}:{stock}@{price}")
            goods_str = " ".join(goods) if goods else "none"
            lines.append(f"port | {p.port_type} | {goods_str}")
        else:
            lines.append("port | none")

        # Bars 6+: Combat participants (only if in combat)
        if self.state.is_combat_active():
            # Sort: characters first (alphabetically), then garrisons
            combatants = sorted(
                self.state.combat_participants.values(),
                key=lambda c: (c.combatant_id.startswith("garrison:"), c.name)
            )

            for c in combatants:
                # Format deltas
                delta_parts = []
                if c.fighters_delta != 0:
                    sign = "+" if c.fighters_delta > 0 else ""
                    delta_parts.append(f"F:{sign}{c.fighters_delta}")
                if c.shields_delta != 0:
                    sign = "+" if c.shields_delta > 0 else ""
                    delta_parts.append(f"S:{sign}{c.shields_delta}")
                delta_str = " | " + " ".join(delta_parts) if delta_parts else ""

                # Format line
                ship_type_str = f" ({c.ship_type})" if c.ship_type else ""
                action_str = f" | {c.last_action}" if c.last_action else ""

                lines.append(
                    f"{c.name}{ship_type_str} | "
                    f"F:{c.fighters}/{c.max_fighters} "
                    f"S:{c.shields}/{c.max_shields}"
                    f"{action_str}"
                    f"{delta_str}"
                )

        return lines
