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
    ship_name: Optional[str] = None
    player_id: Optional[str] = None


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
    quantum_foam: int = 0
    retro_organics: int = 0
    neuro_symbolics: int = 0


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

    # Salvage present in sector
    salvage: List[Dict[str, Any]] = field(default_factory=list)

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

    def _set_garrison_info(self, garrison_data: Optional[Dict[str, Any]]) -> None:
        """Helper to apply garrison information to the state."""
        if isinstance(garrison_data, dict) and garrison_data.get("fighters") is not None:
            owner = (
                garrison_data.get("owner_name")
                or garrison_data.get("owner_id")
                or "unknown"
            )
            fighters = int(garrison_data.get("fighters", 0) or 0)
            mode = garrison_data.get("mode", "unknown")
            toll_amount = garrison_data.get("toll_amount")
            self.state.garrison = GarrisonInfo(
                owner_name=owner,
                fighters=fighters,
                mode=mode,
                toll_amount=toll_amount,
            )
        else:
            self.state.garrison = None

    def _apply_sector_details(
        self,
        sector_data: Dict[str, Any],
        *,
        require_match: bool = False,
    ) -> None:
        """Normalize sector payloads (status, movement.complete, sector.update)."""
        if not isinstance(sector_data, dict):
            return

        sector_id = sector_data.get("id")
        if require_match and sector_id is not None and sector_id != self.state.sector_id:
            return

        if sector_id is not None:
            self.state.sector_id = sector_id

        if "adjacent_sectors" in sector_data:
            self.state.adjacent_sectors = list(sector_data.get("adjacent_sectors", []))

        players_list: Optional[List[Dict[str, Any]]] = None
        if "players" in sector_data:
            players_list = sector_data.get("players") or []
        elif "other_players" in sector_data:
            players_list = sector_data.get("other_players") or []

        if players_list is not None:
            ships: List[ShipInfo] = []
            for entry in players_list:
                if not isinstance(entry, dict):
                    continue

                raw_player = entry.get("player")
                player_name: Optional[str] = None
                player_id: Optional[str] = None
                if isinstance(raw_player, dict):
                    player_name = raw_player.get("name") or raw_player.get("id")
                    player_id = raw_player.get("id")

                if player_name is None:
                    player_name = entry.get("name")
                if player_id is None:
                    player_id = entry.get("id") or entry.get("character_id")

                ship_entry = entry.get("ship") if isinstance(entry.get("ship"), dict) else {}
                ship_type = ship_entry.get("ship_type") or entry.get("ship_type", "unknown")
                ship_name = ship_entry.get("ship_name")

                if player_name is None:
                    player_name = player_id or "?"

                ships.append(
                    ShipInfo(
                        name=player_name,
                        ship_type=ship_type or "unknown",
                        ship_name=ship_name,
                        player_id=player_id,
                    )
                )

            self.state.ships = ships

        garrison_data = sector_data.get("garrison")
        if not garrison_data:
            garrisons_list = sector_data.get("garrisons")
            if isinstance(garrisons_list, list) and garrisons_list:
                garrison_data = garrisons_list[0]

        if "garrison" in sector_data or "garrisons" in sector_data:
            self._set_garrison_info(garrison_data)

        if "port" in sector_data:
            port_data = sector_data.get("port")
            if isinstance(port_data, dict):
                self.state.port = PortInfo(
                    port_type=port_data.get("code", "unknown"),
                    stock=port_data.get("stock", port_data.get("last_seen_stock", {})),
                    prices=port_data.get("prices", port_data.get("last_seen_prices", {})),
                )
            else:
                self.state.port = None

        if "salvage" in sector_data:
            salvage_list = sector_data.get("salvage") or []
            self.state.salvage = list(salvage_list)

    def update_from_status(self, status_payload: dict) -> None:
        """Update from status.update event"""
        # Status can come in two formats:
        # 1. Full status: {"player": {...}, "ship": {...}, "sector": {...}}
        # 2. Legacy format: {"sector": int, "ship": {...}, "sector_contents": {...}}

        # Determine format and normalize
        player_data: Dict[str, Any] = {}
        if "player" in status_payload:
            # New format from build_status_payload
            sector_data = status_payload.get("sector", {})
            ship_data = status_payload.get("ship", {})
            player_data = status_payload.get("player", {})
        else:
            # Legacy format - sector_contents style
            sector_data = status_payload.get("sector_contents", {})
            ship_data = status_payload.get("ship", {})

            # Extract sector_id
            legacy_sector = status_payload.get("sector")
            if legacy_sector is not None:
                self.state.sector_id = legacy_sector

        self._apply_sector_details(sector_data)

        if ship_data or player_data:
            self._update_from_player_ship({"player": player_data, "ship": ship_data})

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
        self._apply_sector_details(sector_data)

        # Return to quiet state if not in combat
        if not self.state.in_combat:
            self.state.combat_state = "quiet"

    def update_from_trade_executed(self, payload: dict) -> None:
        """Update from trade.executed event"""
        # trade.executed includes player and ship data
        self._update_from_player_ship(payload)

    def update_from_port_update(self, payload: dict) -> None:
        """Update from port.update event"""
        sector_ref = payload.get("sector")
        port_data = {}
        if isinstance(sector_ref, dict):
            port_data = sector_ref.get("port", {})

        if port_data:
            sector_id = _extract_sector_id(sector_ref)
            if sector_id is None or sector_id == self.state.sector_id:
                if self.state.port:
                    if port_data.get("code"):
                        self.state.port.port_type = port_data.get("code", self.state.port.port_type)
                    self.state.port.stock = port_data.get("stock", {})
                    self.state.port.prices = port_data.get("prices", {})
                else:
                    self.state.port = PortInfo(
                        port_type=port_data.get("code", "unknown"),
                        stock=port_data.get("stock", {}),
                        prices=port_data.get("prices", {}),
                    )

    def update_from_sector_update(self, payload: dict) -> None:
        """Update sector details from sector.update events."""
        sector_data = payload.get("sector") if isinstance(payload.get("sector"), dict) else payload
        self._apply_sector_details(sector_data, require_match=True)

    def update_from_garrison_event(self, event_name: str, payload: dict) -> None:
        """Update state from garrison-related events."""
        sector_ref = payload.get("sector")
        sector_id = _extract_sector_id(sector_ref)
        if sector_id is not None and sector_id != self.state.sector_id:
            return

        if "garrison" in payload:
            self._set_garrison_info(payload.get("garrison"))
        elif event_name == "garrison.collected":
            # Explicitly clear garrison when none returned
            self._set_garrison_info(payload.get("garrison"))

        fighters_remaining = payload.get("fighters_remaining")
        if isinstance(fighters_remaining, int):
            self.state.fighters = fighters_remaining

        fighters_on_ship = payload.get("fighters_on_ship")
        if isinstance(fighters_on_ship, int):
            self.state.fighters = fighters_on_ship

        credits_collected = payload.get("credits_collected")
        if isinstance(credits_collected, int):
            self.state.credits += credits_collected

    def update_from_salvage_collected(self, payload: dict) -> None:
        """Update cargo/credits when salvage is collected."""
        sector_ref = payload.get("sector")
        sector_id = _extract_sector_id(sector_ref)
        if sector_id is not None and sector_id != self.state.sector_id:
            return

        salvage_entry = payload.get("salvage")
        if salvage_entry:
            salvage_id = salvage_entry.get("salvage_id")
            if salvage_id:
                self.state.salvage = [
                    item for item in self.state.salvage if item.get("salvage_id") != salvage_id
                ]
        elif salvage_entry is not None:
            # Explicitly provided but empty -> clear list
            self.state.salvage = []

        cargo_after = payload.get("cargo")
        if isinstance(cargo_after, dict):
            self.state.cargo = CargoInfo(
                quantum_foam=cargo_after.get("quantum_foam", self.state.cargo.quantum_foam),
                retro_organics=cargo_after.get("retro_organics", self.state.cargo.retro_organics),
                neuro_symbolics=cargo_after.get("neuro_symbolics", self.state.cargo.neuro_symbolics),
            )

        credits_after = payload.get("credits")
        if isinstance(credits_after, int):
            self.state.credits = credits_after

    def update_from_status_update(self, payload: dict) -> None:
        """Update from status.update event (direct handler, same as update_from_status)"""
        # This is just an alias for update_from_status for consistency
        self.update_from_status(payload)

    def update_from_character_moved(self, payload: dict) -> None:
        """Update from character.moved event.

        Payload structure:
        {
            "player": {"id": str, "name": str},
            "ship": {"ship_name": str, "ship_type": str},
            "timestamp": "...",
            "move_type": "normal",
            "movement": "arrive" or "depart",
            ...
        }
        """
        movement = payload.get("movement")
        player = payload.get("player") or {}
        ship = payload.get("ship") or {}

        player_id = player.get("id") or payload.get("character_id")
        char_name = player.get("name") or payload.get("name") or player_id
        ship_type = ship.get("ship_type") or payload.get("ship_type")
        ship_name = ship.get("ship_name")

        if not char_name and not player_id:
            return

        identifier = player_id or char_name

        if movement == "arrive":
            # Add ship to list if not already present
            existing = None
            for ship_info in self.state.ships:
                if ship_info.player_id and ship_info.player_id == identifier:
                    existing = ship_info
                    break
                if not ship_info.player_id and char_name and ship_info.name == char_name:
                    existing = ship_info
                    break

            if existing:
                if char_name:
                    existing.name = char_name
                if ship_type:
                    existing.ship_type = ship_type
                if ship_name:
                    existing.ship_name = ship_name
                if player_id:
                    existing.player_id = player_id
            else:
                self.state.ships.append(
                    ShipInfo(
                        name=char_name or identifier,
                        ship_type=ship_type or "unknown",
                        ship_name=ship_name,
                        player_id=player_id,
                    )
                )
        elif movement == "depart":
            # Remove ship from list
            filtered: List[ShipInfo] = []
            for ship_info in self.state.ships:
                if ship_info.player_id and identifier:
                    if ship_info.player_id == identifier:
                        continue
                elif char_name and ship_info.name == char_name:
                    continue
                filtered.append(ship_info)
            self.state.ships = filtered

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
                quantum_foam=cargo.get("quantum_foam", self.state.cargo.quantum_foam),
                retro_organics=cargo.get("retro_organics", self.state.cargo.retro_organics),
                neuro_symbolics=cargo.get("neuro_symbolics", self.state.cargo.neuro_symbolics)
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
            f"cargo QF:{self.state.cargo.quantum_foam} "
            f"RO:{self.state.cargo.retro_organics} "
            f"NS:{self.state.cargo.neuro_symbolics} | "
            f"warp {self.state.warp_power}/{self.state.max_warp_power}"
        )

        # Bar 3: Ships in sector
        if self.state.ships:
            def _format_ship_entry(info: ShipInfo) -> str:
                ship_label = info.ship_name or info.ship_type or "unknown ship"
                if info.ship_name and info.ship_type:
                    ship_label = f"{info.ship_name} ({info.ship_type})"
                return f"{info.name} [{ship_label}]"

            ship_list = ", ".join(_format_ship_entry(s) for s in self.state.ships)
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

        # Salvage information
        if self.state.salvage:
            entries = []
            for item in self.state.salvage:
                if not isinstance(item, dict):
                    continue
                sid = item.get("salvage_id", "?")
                credits = item.get("credits", 0)
                scrap = item.get("scrap")
                parts = [f"C{credits}"]
                if isinstance(scrap, (int, float)) and scrap:
                    parts.append(f"S{int(scrap)}")
                entries.append(f"{sid} ({', '.join(parts)})")
            salvage_str = ", ".join(entries) if entries else "none"
            lines.append(f"salvage | {salvage_str}")
        else:
            lines.append("salvage | none")

        # Bar 5: Port
        if self.state.port:
            p = self.state.port
            # Format: QF:700@24 RO:300@12 NS:300@49
            goods = []
            for commodity, short in [("quantum_foam", "QF"), ("retro_organics", "RO"), ("neuro_symbolics", "NS")]:
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
