"""Status bar widget showing current game state."""

from textual.app import ComposeResult
from textual.containers import Horizontal
from textual.widgets import Static
from textual.reactive import reactive
from typing import Optional, Dict, Any


class StatusBarWidget(Horizontal):
    """Widget displaying current game status in a horizontal bar."""
    
    DEFAULT_CSS = """
    StatusBarWidget {
        height: 3;
        padding: 0 1;
    }
    
    StatusBarWidget Static {
        width: 1fr;
        height: 100%;
        content-align: center middle;
    }
    """
    
    # Reactive properties for automatic updates
    credits = reactive(0)
    sector = reactive(0)
    ship_type = reactive("Unknown")
    cargo_fuel = reactive(0)
    cargo_organics = reactive(0)
    cargo_equipment = reactive(0)
    cargo_capacity = reactive(0)
    cargo_used = reactive(0)
    warp_power = reactive(0)
    warp_power_capacity = reactive(0)
    
    def compose(self) -> ComposeResult:
        """Create child widgets."""
        yield Static("Credits: 0", id="status-credits")
        yield Static("Sector: 0", id="status-sector")
        yield Static("Ship: Unknown", id="status-ship")
        yield Static("Warp: 0/0", id="status-warp")
        yield Static("Cargo: FO:0 OG:0 EQ:0", id="status-cargo")
        yield Static("Free: 0/0", id="status-holds")
    
    def watch_credits(self, credits: int) -> None:
        """Update credits display."""
        widget = self.query_one("#status-credits", Static)
        widget.update(f"Credits: {credits:,}")
    
    def watch_sector(self, sector: int) -> None:
        """Update sector display."""
        widget = self.query_one("#status-sector", Static)
        widget.update(f"Sector: {sector}")
    
    def watch_ship_type(self, ship_type: str) -> None:
        """Update ship type display."""
        widget = self.query_one("#status-ship", Static)
        # Shorten ship names for display
        short_names = {
            "kestrel_courier": "Kestrel",
            "stellar_freighter": "Freighter",
            "vortex_marauder": "Marauder"
        }
        display_name = short_names.get(ship_type, ship_type)
        widget.update(f"Ship: {display_name}")
    
    def watch_cargo_fuel(self) -> None:
        """Update cargo display when fuel changes."""
        self._update_cargo_display()
    
    def watch_cargo_organics(self) -> None:
        """Update cargo display when organics change."""
        self._update_cargo_display()
    
    def watch_cargo_equipment(self) -> None:
        """Update cargo display when equipment changes."""
        self._update_cargo_display()
    
    def watch_cargo_capacity(self) -> None:
        """Update holds display when capacity changes."""
        self._update_holds_display()
    
    def watch_cargo_used(self) -> None:
        """Update holds display when used space changes."""
        self._update_holds_display()
    
    def watch_warp_power(self) -> None:
        """Update warp power display when warp power changes."""
        self._update_warp_display()
    
    def watch_warp_power_capacity(self) -> None:
        """Update warp power display when capacity changes."""
        self._update_warp_display()
    
    def _update_warp_display(self) -> None:
        """Update the warp power display widget."""
        widget = self.query_one("#status-warp", Static)
        widget.update(f"Warp: {self.warp_power}/{self.warp_power_capacity}")
    
    def _update_cargo_display(self) -> None:
        """Update the cargo display widget."""
        widget = self.query_one("#status-cargo", Static)
        widget.update(f"Cargo: FO:{self.cargo_fuel} OG:{self.cargo_organics} EQ:{self.cargo_equipment}")
    
    def _update_holds_display(self) -> None:
        """Update the holds display widget."""
        widget = self.query_one("#status-holds", Static)
        free = self.cargo_capacity - self.cargo_used
        widget.update(f"Free: {free}/{self.cargo_capacity}")
    
    def update_from_status(self, status: Dict[str, Any]) -> None:
        """Update all fields from a status response.
        
        Args:
            status: Status response from my_status or move API calls
        """
        # Update sector
        if "sector" in status:
            self.sector = status["sector"]
        
        # Update ship and cargo information
        if "ship" in status:
            ship = status["ship"]
            
            # Credits
            if "credits" in ship:
                self.credits = ship["credits"]
            
            # Ship type
            if "ship_type" in ship:
                self.ship_type = ship["ship_type"]
            
            # Cargo
            if "cargo" in ship:
                cargo = ship["cargo"]
                self.cargo_fuel = cargo.get("fuel_ore", 0)
                self.cargo_organics = cargo.get("organics", 0)
                self.cargo_equipment = cargo.get("equipment", 0)
            
            # Cargo capacity
            if "cargo_capacity" in ship:
                self.cargo_capacity = ship["cargo_capacity"]
            if "cargo_used" in ship:
                self.cargo_used = ship["cargo_used"]
            
            # Warp Power
            if "warp_power" in ship:
                self.warp_power = ship["warp_power"]
            if "warp_power_capacity" in ship:
                self.warp_power_capacity = ship["warp_power_capacity"]
        
        # Also handle direct ship data (from task executor)
        elif all(key in status for key in ["ship_type", "cargo", "credits"]):
            self.credits = status.get("credits", self.credits)
            self.ship_type = status.get("ship_type", self.ship_type)
            
            if "cargo" in status:
                cargo = status["cargo"]
                self.cargo_fuel = cargo.get("fuel_ore", 0)
                self.cargo_organics = cargo.get("organics", 0)
                self.cargo_equipment = cargo.get("equipment", 0)
            
            if "cargo_capacity" in status:
                self.cargo_capacity = status["cargo_capacity"]
            if "cargo_used" in status:
                self.cargo_used = status["cargo_used"]
            
            if "warp_power" in status:
                self.warp_power = status["warp_power"]
            if "warp_power_capacity" in status:
                self.warp_power_capacity = status["warp_power_capacity"]
    
    def update_from_trade(self, trade_result: Dict[str, Any]) -> None:
        """Update from a trade result.
        
        Args:
            trade_result: Result from a trade API call
        """
        # Update credits
        if "new_credits" in trade_result:
            self.credits = trade_result["new_credits"]
        
        # Update cargo
        if "new_cargo" in trade_result:
            cargo = trade_result["new_cargo"]
            self.cargo_fuel = cargo.get("fuel_ore", 0)
            self.cargo_organics = cargo.get("organics", 0)
            self.cargo_equipment = cargo.get("equipment", 0)
            # Recalculate used space
            self.cargo_used = self.cargo_fuel + self.cargo_organics + self.cargo_equipment