#!/usr/bin/env python3
"""
Compare Universe Data: JSON Files vs Supabase Tables

Compares 25 strategically selected sectors between the legacy JSON files
and the Supabase database to verify data integrity.
"""

import json
import os
import random
from pathlib import Path
from typing import Dict, List, Tuple

from dotenv import load_dotenv
from supabase import create_client, Client

# Load environment variables
load_dotenv()

# Colors for output
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
BLUE = "\033[94m"
RESET = "\033[0m"


class UniverseComparator:
    def __init__(self, json_dir: Path, supabase_url: str, supabase_key: str):
        self.json_dir = json_dir
        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.mismatches = []
        self.matches = 0

    def load_json_files(self) -> Tuple[Dict, Dict]:
        """Load universe structure and sector contents JSON files."""
        structure_path = self.json_dir / "universe_structure.json"
        contents_path = self.json_dir / "sector_contents.json"

        with open(structure_path) as f:
            structure = json.load(f)

        with open(contents_path) as f:
            contents = json.load(f)

        return structure, contents

    def select_sectors(self, structure: Dict, contents: Dict) -> List[int]:
        """Select 25 strategic sectors for comparison."""
        all_sector_ids = [s["id"] for s in structure["sectors"]]
        sectors_with_ports = [s["id"] for s in contents["sectors"] if s.get("port")]
        sectors_without_ports = [s["id"] for s in contents["sectors"] if not s.get("port")]

        selected = []

        # Always include sector 0 (mega port)
        selected.append(0)

        # Add first 4 sectors
        selected.extend([1, 2, 3, 4])

        # Add 10 random sectors with ports (excluding already selected)
        port_candidates = [s for s in sectors_with_ports if s not in selected and s < 4000]
        selected.extend(random.sample(port_candidates, min(10, len(port_candidates))))

        # Add 10 random sectors without ports (excluding already selected)
        no_port_candidates = [s for s in sectors_without_ports if s not in selected and s < 4000]
        selected.extend(random.sample(no_port_candidates, min(10, len(no_port_candidates))))

        # Ensure we have exactly 25
        return sorted(selected[:25])

    def get_sector_from_json(self, sector_id: int, structure: Dict, contents: Dict) -> Dict:
        """Extract sector data from JSON files."""
        # Find in structure
        sector_structure = next((s for s in structure["sectors"] if s["id"] == sector_id), None)
        sector_contents = next((s for s in contents["sectors"] if s["id"] == sector_id), None)

        if not sector_structure or not sector_contents:
            return None

        return {
            "sector_id": sector_id,
            "position_x": sector_structure["position"]["x"],
            "position_y": sector_structure["position"]["y"],
            "region": sector_structure.get("region", 0),
            "warps": sector_structure.get("warps", []),
            "port": sector_contents.get("port"),
        }

    def get_sector_from_supabase(self, sector_id: int) -> Dict:
        """Extract sector data from Supabase."""
        # Get sector structure
        structure = self.supabase.table("universe_structure").select("*").eq("sector_id", sector_id).single().execute()

        # Get sector contents
        contents = self.supabase.table("sector_contents").select("*").eq("sector_id", sector_id).single().execute()

        # Get port if exists
        port_result = self.supabase.table("ports").select("*").eq("sector_id", sector_id).execute()
        port = port_result.data[0] if port_result.data else None

        return {
            "sector_id": sector_id,
            "position_x": structure.data["position_x"],
            "position_y": structure.data["position_y"],
            "region": structure.data["region"],
            "warps": json.loads(structure.data["warps"]),
            "port": port,
        }

    def convert_port_stock(self, port_data: Dict, commodity_index: int) -> Tuple[int, int]:
        """Convert port stock from legacy format (same logic as loader)."""
        port_code = port_data["code"][commodity_index]
        commodity_keys = ["QF", "RO", "NS"]
        commodity = commodity_keys[commodity_index]

        if port_code == "S":  # Sells commodity
            stock = port_data["stock"].get(commodity, 0)
            max_stock = port_data["stock_max"].get(commodity, 0)
        elif port_code == "B":  # Buys commodity
            demand = port_data["demand"].get(commodity, 0)
            demand_max = port_data["demand_max"].get(commodity, 0)
            stock = demand_max - demand
            max_stock = demand_max
        else:  # Neutral
            stock = 0
            max_stock = 0

        return (stock, max_stock)

    def compare_sectors(self, sector_id: int, json_data: Dict, supabase_data: Dict) -> bool:
        """Compare a single sector and report differences."""
        print(f"\n{BLUE}=== Sector {sector_id} ==={RESET}")
        has_mismatch = False

        # Compare position
        if abs(json_data["position_x"] - supabase_data["position_x"]) > 0.001:
            print(f"{RED}✗ Position X mismatch:{RESET} JSON={json_data['position_x']}, DB={supabase_data['position_x']}")
            self.mismatches.append(f"Sector {sector_id}: position_x")
            has_mismatch = True

        if abs(json_data["position_y"] - supabase_data["position_y"]) > 0.001:
            print(f"{RED}✗ Position Y mismatch:{RESET} JSON={json_data['position_y']}, DB={supabase_data['position_y']}")
            self.mismatches.append(f"Sector {sector_id}: position_y")
            has_mismatch = True

        # Compare region (convert int to name)
        structure_json = self.load_json_files()[0]
        region_map = {r["id"]: r["name"] for r in structure_json["meta"].get("regions", [])}
        expected_region = region_map.get(json_data["region"], f"Region {json_data['region']}")

        if expected_region != supabase_data["region"]:
            print(f"{RED}✗ Region mismatch:{RESET} JSON={expected_region}, DB={supabase_data['region']}")
            self.mismatches.append(f"Sector {sector_id}: region")
            has_mismatch = True

        # Compare warps (just count and basic structure)
        if len(json_data["warps"]) != len(supabase_data["warps"]):
            print(f"{RED}✗ Warp count mismatch:{RESET} JSON={len(json_data['warps'])}, DB={len(supabase_data['warps'])}")
            self.mismatches.append(f"Sector {sector_id}: warp_count")
            has_mismatch = True
        else:
            # Compare warp destinations
            json_warp_dests = sorted([w["to"] for w in json_data["warps"]])
            db_warp_dests = sorted([w["to"] for w in supabase_data["warps"]])
            if json_warp_dests != db_warp_dests:
                print(f"{RED}✗ Warp destinations mismatch:{RESET} JSON={json_warp_dests}, DB={db_warp_dests}")
                self.mismatches.append(f"Sector {sector_id}: warp_destinations")
                has_mismatch = True

        # Compare port data
        json_has_port = json_data["port"] is not None
        db_has_port = supabase_data["port"] is not None

        if json_has_port != db_has_port:
            print(f"{RED}✗ Port presence mismatch:{RESET} JSON has port={json_has_port}, DB has port={db_has_port}")
            self.mismatches.append(f"Sector {sector_id}: port_presence")
            has_mismatch = True
        elif json_has_port:
            # Compare port details
            json_port = json_data["port"]
            db_port = supabase_data["port"]

            if json_port["code"] != db_port["port_code"]:
                print(f"{RED}✗ Port code mismatch:{RESET} JSON={json_port['code']}, DB={db_port['port_code']}")
                self.mismatches.append(f"Sector {sector_id}: port_code")
                has_mismatch = True

            if json_port["class"] != db_port["port_class"]:
                print(f"{RED}✗ Port class mismatch:{RESET} JSON={json_port['class']}, DB={db_port['port_class']}")
                self.mismatches.append(f"Sector {sector_id}: port_class")
                has_mismatch = True

            # Compare stock levels (with conversion)
            for idx, commodity in enumerate(["QF", "RO", "NS"]):
                expected_stock, expected_max = self.convert_port_stock(json_port, idx)
                db_stock_field = f"stock_{commodity.lower()}"
                db_max_field = f"max_{commodity.lower()}"

                if expected_stock != db_port[db_stock_field]:
                    print(f"{RED}✗ {commodity} stock mismatch:{RESET} Expected={expected_stock}, DB={db_port[db_stock_field]}")
                    self.mismatches.append(f"Sector {sector_id}: {commodity}_stock")
                    has_mismatch = True

                if expected_max != db_port[db_max_field]:
                    print(f"{RED}✗ {commodity} max mismatch:{RESET} Expected={expected_max}, DB={db_port[db_max_field]}")
                    self.mismatches.append(f"Sector {sector_id}: {commodity}_max")
                    has_mismatch = True

        if not has_mismatch:
            print(f"{GREEN}✓ All data matches!{RESET}")
            self.matches += 1

        return not has_mismatch

    def run_comparison(self):
        """Run the full comparison."""
        print(f"\n{YELLOW}{'='*80}{RESET}")
        print(f"{YELLOW}Universe Data Comparison: JSON Files vs Supabase Tables{RESET}")
        print(f"{YELLOW}{'='*80}{RESET}\n")

        # Load JSON files
        print("Loading JSON files...")
        structure, contents = self.load_json_files()
        print(f"✓ Loaded {len(structure['sectors'])} sectors from JSON files")

        # Select sectors
        print("\nSelecting 25 strategic sectors...")
        selected_sectors = self.select_sectors(structure, contents)
        print(f"✓ Selected sectors: {selected_sectors}")

        # Compare each sector
        print(f"\n{YELLOW}Starting comparison...{RESET}")
        for sector_id in selected_sectors:
            json_data = self.get_sector_from_json(sector_id, structure, contents)
            supabase_data = self.get_sector_from_supabase(sector_id)

            if json_data is None:
                print(f"{RED}✗ Sector {sector_id} not found in JSON files!{RESET}")
                self.mismatches.append(f"Sector {sector_id}: not_in_json")
                continue

            self.compare_sectors(sector_id, json_data, supabase_data)

        # Print summary
        print(f"\n{YELLOW}{'='*80}{RESET}")
        print(f"{YELLOW}Comparison Summary{RESET}")
        print(f"{YELLOW}{'='*80}{RESET}")
        print(f"Total sectors compared: {len(selected_sectors)}")
        print(f"{GREEN}Matching sectors: {self.matches}{RESET}")
        print(f"{RED}Sectors with mismatches: {len(selected_sectors) - self.matches}{RESET}")

        if self.mismatches:
            print(f"\n{RED}Mismatches found:{RESET}")
            for mismatch in self.mismatches:
                print(f"  - {mismatch}")
            return False
        else:
            print(f"\n{GREEN}✓✓✓ ALL SECTORS MATCH PERFECTLY! ✓✓✓{RESET}")
            return True


def main():
    json_dir = Path("world-data")
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        print(f"{RED}Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set{RESET}")
        return 1

    # Set random seed for reproducible sector selection
    random.seed(1234)

    comparator = UniverseComparator(json_dir, supabase_url, supabase_key)
    success = comparator.run_comparison()

    return 0 if success else 1


if __name__ == "__main__":
    exit(main())
