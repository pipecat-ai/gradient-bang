"""
Status bar data structures and updater for combat TUI.

Provides a clean interface for managing all status bar state,
updating from server events, and formatting for display.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from datetime import datetime


def _extract_sector_id(value: Any) -> Optional[int]:
    if isinstance(value, dict):
        return value.get("id")
    return value


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
    fighters: Optional[int]
    shields: Optional[int]
    max_fighters: Optional[int]
    max_shields: Optional[int]
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
    combat_state: str = "quiet"  # "quiet", "in_combat", "waiting_round_1", "hyperspace", etc.
    adjacent_sectors: List[int] = field(default_factory=list)
    in_hyperspace: bool = False
    hyperspace_eta: Optional[float] = None
    hyperspace_destination: Optional[int] = None

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
        # Status can come in two formats:
        # 1. Full status: {"player": {...}, "ship": {...}, "sector": {...}}
        # 2. Legacy format: {"sector": int, "ship": {...}, "sector_contents": {...}}

        # Determine format and normalize
        if "player" in status_payload:
            # New format from build_status_payload
            sector_data = status_payload.get("sector", {})
            ship_data = status_payload.get("ship", {})
            player_data = status_payload.get("player", {})

            # Extract sector_id
            self.state.sector_id = sector_data.get("id", self.state.sector_id)

            # Update from player data
            if "credits_on_hand" in player_data:
                self.state.credits = player_data["credits_on_hand"]
        else:
            # Legacy format - sector_contents style
            sector_data = status_payload.get("sector_contents", {})
            ship_data = status_payload.get("ship", {})

            # Extract sector_id
            legacy_sector = status_payload.get("sector")
            if legacy_sector is not None:
                self.state.sector_id = legacy_sector

        # Update adjacent sectors
        self.state.adjacent_sectors = sector_data.get("adjacent_sectors", [])

        # Bar 2: Ship stats
        if "credits" in ship_data:
            self.state.credits = ship_data["credits"]
        self.state.fighters = ship_data.get("fighters", 0)
        self.state.shields = ship_data.get("shields", 0)
        self.state.max_fighters = ship_data.get("max_fighters", 0)
        self.state.max_shields = ship_data.get("max_shields", 0)
        self.state.warp_power = ship_data.get("warp_power", 0)
        self.state.max_warp_power = ship_data.get("warp_power_capacity", 0)

        cargo = ship_data.get("cargo", {})
        self.state.cargo = CargoInfo(
            fuel_ore=cargo.get("fuel_ore", 0),
            organics=cargo.get("organics", 0),
            equipment=cargo.get("equipment", 0)
        )

        # Bar 3: Ships in sector - handle both "players" and "other_players"
        players_list = sector_data.get("players", sector_data.get("other_players", []))
        self.state.ships = [
            ShipInfo(
                name=c["name"],
                ship_type=c.get("ship", {}).get("ship_type", c.get("ship_type", "unknown"))
            )
            for c in players_list
        ]

        # Bar 4: Garrison
        garrison_data = sector_data.get("garrison")
        if garrison_data:
            self.state.garrison = GarrisonInfo(
                owner_name=garrison_data.get("owner_name", garrison_data.get("owner_id")),
                fighters=garrison_data["fighters"],
                mode=garrison_data["mode"],
                toll_amount=garrison_data.get("toll_amount")
            )
        else:
            self.state.garrison = None

        # Bar 5: Port - handle both formats
        port_data = sector_data.get("port")
        if port_data:
            self.state.port = PortInfo(
                port_type=port_data.get("code", "unknown"),
                stock=port_data.get("stock", port_data.get("last_seen_stock", {})),
                prices=port_data.get("prices", port_data.get("last_seen_prices", {}))
            )
        else:
            self.state.port = None

    def update_from_combat_started(self, payload: dict) -> None:
        """Deprecated: combat.started no longer emitted; treat as combat.round_waiting."""
        self.update_from_combat_round_waiting(payload)

    def update_from_combat_round_waiting(self, payload: dict) -> None:
        """Update from combat.round_waiting event"""
        self.state.in_combat = True
        self.state.combat_id = payload.get("combat_id", self.state.combat_id)
        self.state.current_round = payload["round"]
        self.state.combat_state = f"waiting_round_{payload['round']}"
        deadline_str = payload["deadline"]
        if deadline_str:
            self.state.deadline = datetime.fromisoformat(deadline_str.replace("Z", "+00:00"))

        # Update participants (may have changed due to flee/defeat)
        participants = payload.get("participants", {})
        self._update_combat_participants(participants, {})
        self._apply_ship(payload)

    def update_from_combat_round_resolved(self, payload: dict) -> None:
        """Update from combat.round_resolved event"""
        self.state.combat_state = f"resolved_round_{payload['round']}"

        # Update participants with deltas and actions
        participants = payload.get("participants", {})
        actions = payload.get("actions", {})

        self._update_combat_participants(participants, actions)
        self._apply_ship(payload)

    def update_from_combat_ended(self, payload: dict) -> None:
        """Update from combat.ended event"""
        self.state.in_combat = False
        self.state.combat_state = "quiet"
        self.state.combat_id = None
        self.state.current_round = 0
        self.state.deadline = None
        self.state.combat_participants.clear()

    def update_from_movement_start(self, payload: dict) -> None:
        """Update from movement.start event"""
        sector_data = payload.get("sector", {})
        self.state.in_hyperspace = True
        self.state.hyperspace_destination = sector_data.get("id")
        self.state.hyperspace_eta = payload.get("hyperspace_time")

        if self.state.hyperspace_destination:
            self.state.combat_state = f"hyperspace→{self.state.hyperspace_destination}"
        else:
            self.state.combat_state = "hyperspace"

    def update_from_movement_complete(self, payload: dict) -> None:
        """Update from movement.complete event"""
        # Clear hyperspace state
        self.state.in_hyperspace = False
        self.state.hyperspace_eta = None
        self.state.hyperspace_destination = None

        # movement.complete includes player, ship, and sector - update everything
        self._update_from_player_ship(payload)

        # Update sector info
        sector_data = payload.get("sector", {})
        self.state.sector_id = sector_data.get("id", self.state.sector_id)
        self.state.adjacent_sectors = sector_data.get("adjacent_sectors", [])

        # Update sector occupants - note: field is "players" not "other_players"
        self.state.ships = [
            ShipInfo(
                name=c["name"],
                ship_type=c.get("ship", {}).get("ship_type", "unknown")
            )
            for c in sector_data.get("players", [])
        ]

        # Update garrison
        garrison_data = sector_data.get("garrison")
        if garrison_data:
            self.state.garrison = GarrisonInfo(
                owner_name=garrison_data.get("owner_name", garrison_data.get("owner_id", "?")),
                fighters=garrison_data["fighters"],
                mode=garrison_data["mode"],
                toll_amount=garrison_data.get("toll_amount")
            )
        else:
            self.state.garrison = None

        # Update port
        port_data = sector_data.get("port")
        if port_data:
            self.state.port = PortInfo(
                port_type=port_data.get("code", "unknown"),
                stock=port_data.get("stock", {}),
                prices=port_data.get("prices", {})
            )
        else:
            self.state.port = None

        # Return to quiet state if not in combat
        if not self.state.in_combat:
            self.state.combat_state = "quiet"

    def update_from_trade_executed(self, payload: dict) -> None:
        """Update from trade.executed event"""
        # trade.executed includes player and ship data
        self._update_from_player_ship(payload)

    def update_from_port_update(self, payload: dict) -> None:
        """Update from port.update event"""
        port_data = payload.get("port", {})
        if port_data:
            # Update port info if we're still in the same sector
            sector_ref = payload.get("sector")
            sector_id = _extract_sector_id(sector_ref)
            if sector_id is None or sector_id == self.state.sector_id:
                if self.state.port:
                    # Update existing port
                    self.state.port.stock = port_data.get("stock", {})
                    self.state.port.prices = port_data.get("prices", {})
                else:
                    # Create new port entry
                    self.state.port = PortInfo(
                        port_type=port_data.get("code", "unknown"),
                        stock=port_data.get("stock", {}),
                        prices=port_data.get("prices", {})
                    )

    def update_from_status_update(self, payload: dict) -> None:
        """Update from status.update event (direct handler, same as update_from_status)"""
        # This is just an alias for update_from_status for consistency
        self.update_from_status(payload)

    def update_from_character_moved(self, payload: dict) -> None:
        """Update from character.moved event.

        Payload structure:
        {
            "name": character_id,
            "ship_type": "scout",
            "timestamp": "...",
            "move_type": "normal",
            "movement": "arrive" or "depart"
        }
        """
        movement = payload.get("movement")
        char_name = payload.get("name")
        ship_type = payload.get("ship_type")

        if not char_name:
            return

        if movement == "arrive":
            # Add ship to list if not already present
            if not any(s.name == char_name for s in self.state.ships):
                self.state.ships.append(ShipInfo(name=char_name, ship_type=ship_type or "unknown"))
        elif movement == "depart":
            # Remove ship from list
            self.state.ships = [s for s in self.state.ships if s.name != char_name]

    def _update_from_player_ship(self, payload: dict) -> None:
        """Helper to update state from player and ship data in event payload"""
        player_data = payload.get("player", {})
        ship_data = payload.get("ship", {})

        # Update credits from player
        if "credits_on_hand" in player_data:
            self.state.credits = player_data["credits_on_hand"]

        # Update ship stats
        if "fighters" in ship_data:
            self.state.fighters = ship_data["fighters"]
        if "shields" in ship_data:
            self.state.shields = ship_data["shields"]
        if "max_fighters" in ship_data:
            self.state.max_fighters = ship_data["max_fighters"]
        if "max_shields" in ship_data:
            self.state.max_shields = ship_data["max_shields"]
        if "warp_power" in ship_data:
            self.state.warp_power = ship_data["warp_power"]
        if "warp_power_capacity" in ship_data:
            self.state.max_warp_power = ship_data["warp_power_capacity"]

        # Update cargo
        cargo = ship_data.get("cargo", {})
        if cargo:
            self.state.cargo = CargoInfo(
                fuel_ore=cargo.get("fuel_ore", self.state.cargo.fuel_ore),
                organics=cargo.get("organics", self.state.cargo.organics),
                equipment=cargo.get("equipment", self.state.cargo.equipment)
            )

    def _update_combat_participants(
        self,
        participants,
        actions: dict,
    ) -> None:
        """Helper to update combat participant details."""
        entries = participants or []
        previous = self.state.combat_participants.copy()
        self.state.combat_participants.clear()

        for entry in entries:
            name = entry.get("name")
            if not name:
                continue

            ship = entry.get("ship", {})
            prev = previous.get(name)

            combatant = CombatantStatus(
                combatant_id=name,
                name=name,
                ship_type=ship.get("ship_type") or (prev.ship_type if prev else None),
                fighters=prev.fighters if prev else None,
                shields=prev.shields if prev else None,
                max_fighters=prev.max_fighters if prev else None,
                max_shields=prev.max_shields if prev else None,
                is_escape_pod=False,
                fighters_delta=0,
                shields_delta=0,
                last_action=prev.last_action if prev else None,
            )

            shield_damage = ship.get("shield_damage")
            if isinstance(shield_damage, (int, float)):
                combatant.shields_delta = int(shield_damage)

            fighter_loss = ship.get("fighter_loss")
            if isinstance(fighter_loss, (int, float)):
                combatant.fighters_delta = -int(fighter_loss)

            action = actions.get(name)
            if action:
                action_type = action.get("action", "timeout")
                if action_type == "attack":
                    target = action.get("target_id", "?")
                    commit = action.get("commit", 0)
                    combatant.last_action = f"attack→{target}({commit})"
                elif action_type == "flee":
                    dest = action.get("destination_sector", "?")
                    combatant.last_action = f"flee→{dest}"
                elif action_type == "pay":
                    target = action.get("target", "?")
                    combatant.last_action = f"pay→{target}"
                else:
                    combatant.last_action = action_type

            self.state.combat_participants[name] = combatant

    def _apply_ship(self, payload: dict) -> None:
        """Update our own combatant entry with personal ship data."""
        ship_data = payload.get("ship")
        if not ship_data:
            return

        combatant = self.state.combat_participants.get(self.character_id)
        if combatant is None:
            combatant = CombatantStatus(
                combatant_id=self.character_id,
                name=self.character_id,
                ship_type=None,
                fighters=None,
                shields=None,
                max_fighters=None,
                max_shields=None,
                is_escape_pod=False,
            )
            self.state.combat_participants[self.character_id] = combatant

        combatant.ship_type = ship_data.get("ship_type", combatant.ship_type)
        combatant.fighters = ship_data.get("fighters", combatant.fighters)
        combatant.max_fighters = ship_data.get("max_fighters", combatant.max_fighters)
        combatant.shields = ship_data.get("shields", combatant.shields)
        combatant.max_shields = ship_data.get("max_shields", combatant.max_shields)

    def format_status_bars(self) -> List[str]:
        """
        Generate list of formatted status bar strings for display.
        Returns list of strings, one per status bar.
        """
        lines = []

        # Bar 1: Sector and combat state
        adjacent_str = f" | [{', '.join(map(str, sorted(self.state.adjacent_sectors)))}]" if self.state.adjacent_sectors else ""

        # Show hyperspace ETA if in hyperspace
        eta_str = ""
        if self.state.in_hyperspace and self.state.hyperspace_eta:
            eta_str = f" | ETA: {self.state.hyperspace_eta:.1f}s"

        lines.append(f"sector {self.state.sector_id} | {self.state.combat_state}{eta_str}{adjacent_str}")

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

                fighters_str = (
                    f"{c.fighters}/{c.max_fighters}"
                    if c.fighters is not None and c.max_fighters is not None
                    else "?/?"
                )
                shields_str = (
                    f"{c.shields}/{c.max_shields}"
                    if c.shields is not None and c.max_shields is not None
                    else "?/?"
                )

                lines.append(
                    f"{c.name}{ship_type_str} | "
                    f"F:{fighters_str} "
                    f"S:{shields_str}"
                    f"{action_str}"
                    f"{delta_str}"
                )

        return lines
