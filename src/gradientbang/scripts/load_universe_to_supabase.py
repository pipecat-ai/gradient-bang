#!/usr/bin/env python3
"""
Universe Data Loader for Supabase

Loads universe-bang generated JSON files into Supabase tables:
- universe_config (metadata)
- universe_structure (sectors, positions, warps)
- ports (port inventories)
- sector_contents (sector state)

Usage:
    # Load existing JSON files
    uv run scripts/load_universe_to_supabase.py --from-json world-data/

    # Force reload (dangerous!)
    uv run scripts/load_universe_to_supabase.py --from-json world-data/ --force

    # Dry-run validation
    uv run scripts/load_universe_to_supabase.py --from-json world-data/ --dry-run
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

from supabase import create_client, Client

# Load environment variables

BATCH_SIZE = 500  # Rows per batch insert
PAGE_SIZE = 1000  # Rows per page when fetching (PostgREST max_rows default is 1000)


class UniverseLoader:
    """Loads universe data from JSON files into Supabase."""

    def __init__(self, supabase_url: str, supabase_key: str, dry_run: bool = False):
        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.dry_run = dry_run
        self.stats = {
            "sectors_loaded": 0,
            "ports_loaded": 0,
            "sector_contents_loaded": 0,
        }

    def load_json(self, filepath: Path) -> Dict[str, Any]:
        """Load and parse a JSON file."""
        print(f"📂 Loading {filepath}...")
        with open(filepath, "r") as f:
            data = json.load(f)
        print(f"✅ Loaded {filepath.name}")
        return data

    def validate_files(self, structure: Dict, contents: Dict) -> None:
        """Validate JSON structure and consistency."""
        print("\n🔍 Validating JSON files...")

        # Check required keys
        if "meta" not in structure or "sectors" not in structure:
            raise ValueError("universe_structure.json missing required keys: meta, sectors")
        if "meta" not in contents or "sectors" not in contents:
            raise ValueError("sector_contents.json missing required keys: meta, sectors")

        # Check sector counts match
        structure_count = structure["meta"]["sector_count"]
        contents_count = contents["meta"]["sector_count"]
        if structure_count != contents_count:
            raise ValueError(
                f"Sector count mismatch: structure={structure_count}, contents={contents_count}"
            )

        structure_sectors = len(structure["sectors"])
        contents_sectors = len(contents["sectors"])
        if structure_sectors != structure_count:
            raise ValueError(
                f"Structure sector count mismatch: meta={structure_count}, actual={structure_sectors}"
            )
        if contents_sectors != contents_count:
            raise ValueError(
                f"Contents sector count mismatch: meta={contents_count}, actual={contents_sectors}"
            )

        print(f"✅ Validated {structure_count} sectors")

    def _fetch_all(self, table: str, columns: str):
        """Fetch all rows from a table, paging to avoid API max_rows limits."""
        rows = []
        offset = 0
        while True:
            resp = (
                self.supabase.table(table)
                .select(columns)
                .range(offset, offset + PAGE_SIZE - 1)
                .execute()
            )
            chunk = resp.data or []
            rows.extend(chunk)
            if len(chunk) < PAGE_SIZE:
                break
            offset += PAGE_SIZE
        return rows

    def convert_port_stock(self, port_data: Dict, commodity_index: int) -> tuple[int, int]:
        """
        Convert port stock from legacy format to Supabase format.

        Args:
            port_data: Port data from sector_contents.json
            commodity_index: 0=QF, 1=RO, 2=NS

        Returns:
            (stock, max_stock) tuple
        """
        port_code = port_data["code"][commodity_index]
        commodity_keys = ["QF", "RO", "NS"]
        commodity = commodity_keys[commodity_index]

        if port_code == "S":  # Sells commodity
            stock = port_data["stock"].get(commodity, 0)
            max_stock = port_data["stock_max"].get(commodity, 0)
        elif port_code == "B":  # Buys commodity
            # Convert demand to stock (inverse)
            demand = port_data["demand"].get(commodity, 0)
            demand_max = port_data["demand_max"].get(commodity, 0)
            stock = demand_max - demand
            max_stock = demand_max
        else:  # Neutral
            stock = 0
            max_stock = 0

        return (stock, max_stock)

    def check_existing_universe(self) -> bool:
        """Check if universe data already exists."""
        result = self.supabase.table("universe_config").select("id").limit(1).execute()
        return len(result.data) > 0

    def truncate_universe(self) -> None:
        """Truncate all universe tables using raw SQL CASCADE."""
        print("\n🗑️  Truncating existing universe data...")
        if self.dry_run:
            print("   [DRY RUN] Would truncate: all game tables with CASCADE")
            return

        # Use raw SQL to TRUNCATE with CASCADE (handles circular FK dependencies)
        # This deletes all dependent data automatically
        truncate_sql = """
        TRUNCATE TABLE
            universe_config,
            universe_structure,
            ports,
            sector_contents,
            ship_instances,
            characters,
            corporations,
            garrisons,
            events,
            port_transactions
        CASCADE;
        """

        try:
            self.supabase.rpc("exec_sql", {"sql": truncate_sql}).execute()
        except Exception:
            # If RPC doesn't exist, use PostgreSQL REST API directly
            # Try deleting in correct order with proper FK handling
            print("   Using table-by-table deletion (RPC not available)...")

            # Break circular dependencies first
            try:
                self.supabase.table("characters").update({"current_ship_id": None}).neq("character_id", "00000000-0000-0000-0000-000000000000").execute()
                self.supabase.table("characters").update({"corporation_id": None}).neq("character_id", "00000000-0000-0000-0000-000000000000").execute()
                # founder_id is NOT NULL; set to dummy root character instead of NULL
                self.supabase.table("corporations").update(
                    {"founder_id": "00000000-0000-0000-0000-000000000000"}
                ).neq("corp_id", "00000000-0000-0000-0000-000000000000").execute()
            except Exception as e:
                print(f"   ⚠️  Could not clear circular FKs: {e}")

            # Delete corporations (references characters via founder_id)
            try:
                self.supabase.table("corporations").delete().neq("corp_id", "00000000-0000-0000-0000-000000000000").execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete corporations: {e}")

            # Delete ships (no longer referenced by characters)
            try:
                self.supabase.table("ship_instances").delete().gte("current_sector", 0).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete ships: {e}")

            # Delete characters
            try:
                self.supabase.table("characters").delete().neq("character_id", "00000000-0000-0000-0000-000000000000").execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete characters: {e}")

            # Delete universe-dependent tables
            try:
                self.supabase.table("garrisons").delete().gte("sector_id", 0).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete garrisons: {e}")

            try:
                self.supabase.table("events").delete().gte("sector_id", 0).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete events: {e}")

            try:
                self.supabase.table("port_transactions").delete().gte("sector_id", 0).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete port_transactions: {e}")

            # Delete universe tables
            try:
                self.supabase.table("sector_contents").delete().gte("sector_id", 0).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete sector_contents: {e}")

            try:
                self.supabase.table("ports").delete().gte("sector_id", 0).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete ports: {e}")

            try:
                self.supabase.table("universe_structure").delete().gte("sector_id", 0).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete universe_structure: {e}")

            try:
                self.supabase.table("universe_config").delete().eq("id", 1).execute()
            except Exception as e:
                print(f"   ⚠️  Could not delete universe_config: {e}")

        print("✅ Truncated all game tables")

    def load_universe_config(self, structure: Dict, contents: Dict) -> None:
        """Load universe config (metadata)."""
        print("\n📝 Loading universe_config...")

        meta = structure["meta"]

        # Build initial port states for reset_ports function
        initial_port_states = {}
        for sector in contents["sectors"]:
            if sector.get("port"):
                sector_id = sector["id"]
                port_data = sector["port"]
                stock_qf, max_qf = self.convert_port_stock(port_data, 0)
                stock_ro, max_ro = self.convert_port_stock(port_data, 1)
                stock_ns, max_ns = self.convert_port_stock(port_data, 2)

                initial_port_states[str(sector_id)] = {
                    "stock_qf": stock_qf,
                    "stock_ro": stock_ro,
                    "stock_ns": stock_ns,
                }

        config = {
            "id": 1,  # Singleton
            "sector_count": meta["sector_count"],
            "generation_seed": meta.get("seed"),
            "generation_params": {
                "directed": meta.get("directed", True),
                "regions": meta.get("regions", []),
                "initial_port_states": initial_port_states,
            },
            "meta": meta,
        }

        if self.dry_run:
            print(f"   [DRY RUN] Would insert universe_config (seed={meta.get('seed')})")
            print(f"   [DRY RUN] Initial port states: {len(initial_port_states)} ports")
            return

        self.supabase.table("universe_config").insert(config).execute()
        print(f"✅ Loaded universe_config (seed={meta.get('seed')})")

    def load_universe_structure(self, structure: Dict) -> None:
        """Load universe structure (sectors and warps)."""
        print("\n🌌 Loading universe_structure...")

        # Build region ID → name mapping from meta
        region_map = {}
        for region_def in structure["meta"].get("regions", []):
            region_map[region_def["id"]] = region_def["name"]

        if region_map:
            print(f"   Region mapping: {region_map}")
        else:
            print("   ⚠️  No region definitions in meta, using fallback names")

        sectors = structure["sectors"]
        batch = []
        fallback_regions_used = set()

        for i, sector in enumerate(sectors):
            # Convert region ID to name
            region_id = sector.get("region", 0)
            region_name = region_map.get(region_id)

            if region_name is None:
                # Fallback to generated name
                region_name = f"Region {region_id}"
                fallback_regions_used.add(region_id)

            row = {
                "sector_id": sector["id"],
                "position_x": sector["position"]["x"],  # DOUBLE PRECISION
                "position_y": sector["position"]["y"],  # DOUBLE PRECISION
                "region": region_name,  # TEXT (converted from integer)
                "warps": json.dumps(sector.get("warps", [])),  # Store as JSONB
            }
            batch.append(row)

            # Insert in batches
            if len(batch) >= BATCH_SIZE:
                if self.dry_run:
                    print(f"   [DRY RUN] Would insert batch of {len(batch)} sectors")
                else:
                    self.supabase.table("universe_structure").insert(batch).execute()
                    print(f"   Inserted {i + 1}/{len(sectors)} sectors...", end="\r")
                self.stats["sectors_loaded"] += len(batch)
                batch = []

        # Insert remaining
        if batch:
            if self.dry_run:
                print(f"   [DRY RUN] Would insert final batch of {len(batch)} sectors")
            else:
                self.supabase.table("universe_structure").insert(batch).execute()
            self.stats["sectors_loaded"] += len(batch)

        print(f"\n✅ Loaded {self.stats['sectors_loaded']} sectors")

        # Warn about fallback region names
        if fallback_regions_used:
            print(f"   ⚠️  Used fallback names for regions: {sorted(fallback_regions_used)}")

    def load_ports(self, contents: Dict) -> None:
        """Load port inventories."""
        print("\n🏪 Loading ports...")

        sectors_with_ports = [s for s in contents["sectors"] if s.get("port")]
        batch = []

        for i, sector in enumerate(sectors_with_ports):
            port_data = sector["port"]
            sector_id = sector["id"]

            # Convert stock for each commodity
            stock_qf, max_qf = self.convert_port_stock(port_data, 0)
            stock_ro, max_ro = self.convert_port_stock(port_data, 1)
            stock_ns, max_ns = self.convert_port_stock(port_data, 2)

            row = {
                "sector_id": sector_id,
                "port_code": port_data["code"],
                "port_class": port_data["class"],
                "max_qf": max_qf,
                "max_ro": max_ro,
                "max_ns": max_ns,
                "stock_qf": stock_qf,
                "stock_ro": stock_ro,
                "stock_ns": stock_ns,
            }
            batch.append(row)

            # Insert in batches
            if len(batch) >= BATCH_SIZE:
                if self.dry_run:
                    print(f"   [DRY RUN] Would insert batch of {len(batch)} ports")
                else:
                    self.supabase.table("ports").insert(batch).execute()
                    print(f"   Inserted {i + 1}/{len(sectors_with_ports)} ports...", end="\r")
                self.stats["ports_loaded"] += len(batch)
                batch = []

        # Insert remaining
        if batch:
            if self.dry_run:
                print(f"   [DRY RUN] Would insert final batch of {len(batch)} ports")
            else:
                self.supabase.table("ports").insert(batch).execute()
            self.stats["ports_loaded"] += len(batch)

        print(f"\n✅ Loaded {self.stats['ports_loaded']} ports")

    def load_sector_contents(self, contents: Dict) -> None:
        """Load sector contents (references to ports, combat, salvage)."""
        print("\n📦 Loading sector_contents...")

        # First, fetch all port IDs by sector_id (skip in dry-run)
        if self.dry_run:
            # In dry-run mode, use None for all port IDs
            port_map = {}
        else:
            ports_result = self.supabase.table("ports").select("port_id, sector_id").execute()
            port_map = {p["sector_id"]: p["port_id"] for p in ports_result.data}

        sectors = contents["sectors"]
        batch = []

        for i, sector in enumerate(sectors):
            sector_id = sector["id"]
            port_id = port_map.get(sector_id)  # None if no port

            row = {
                "sector_id": sector_id,
                "port_id": port_id,
                "combat": json.dumps({}),  # Empty combat state
                "salvage": json.dumps([]),  # Empty salvage
            }
            batch.append(row)

            # Insert in batches
            if len(batch) >= BATCH_SIZE:
                if self.dry_run:
                    print(f"   [DRY RUN] Would insert batch of {len(batch)} sector_contents")
                else:
                    self.supabase.table("sector_contents").insert(batch).execute()
                    print(f"   Inserted {i + 1}/{len(sectors)} sector_contents...", end="\r")
                self.stats["sector_contents_loaded"] += len(batch)
                batch = []

        # Insert remaining
        if batch:
            if self.dry_run:
                print(f"   [DRY RUN] Would insert final batch of {len(batch)} sector_contents")
            else:
                self.supabase.table("sector_contents").insert(batch).execute()
            self.stats["sector_contents_loaded"] += len(batch)

        print(f"\n✅ Loaded {self.stats['sector_contents_loaded']} sector_contents")

    def verify_integrity(self, structure: Dict) -> None:
        """Verify data integrity after load."""
        print("\n🔍 Verifying data integrity...")

        if self.dry_run:
            print("   [DRY RUN] Skipping verification")
            return

        # Count rows in each table
        config_count = len(self.supabase.table("universe_config").select("id").execute().data)
        structure_rows = self._fetch_all("universe_structure", "sector_id")
        structure_count = len(structure_rows)

        # Query ports by sector_id (not port_id)
        ports = self._fetch_all("ports", "port_id, sector_id, port_code")
        ports_count = len(ports)

        # Verify each port references valid sector
        print("   Verifying port foreign keys...")
        port_sectors = {p["sector_id"] for p in ports}
        structure_sectors = {s["sector_id"] for s in structure_rows}
        orphaned_ports = port_sectors - structure_sectors

        if orphaned_ports:
            raise ValueError(f"Found {len(orphaned_ports)} ports with invalid sector references: {orphaned_ports}")

        contents_count = len(self._fetch_all("sector_contents", "sector_id"))

        expected_sectors = structure["meta"]["sector_count"]

        print(f"   universe_config: {config_count} (expected 1)")
        print(f"   universe_structure: {structure_count} (expected {expected_sectors})")
        print(f"   ports: {ports_count}")
        print(f"   sector_contents: {contents_count} (expected {expected_sectors})")
        print(f"   port FK integrity: ✅ All {ports_count} ports reference valid sectors")

        # Verify counts
        if config_count != 1:
            raise ValueError(f"Expected 1 universe_config row, got {config_count}")
        if structure_count != expected_sectors:
            raise ValueError(f"Expected {expected_sectors} universe_structure rows, got {structure_count}")
        if contents_count != expected_sectors:
            raise ValueError(f"Expected {expected_sectors} sector_contents rows, got {contents_count}")

        print("✅ Integrity check passed")

    def load(self, data_dir: Path) -> None:
        """Main load process."""
        # Load JSON files
        structure_path = data_dir / "universe_structure.json"
        contents_path = data_dir / "sector_contents.json"

        if not structure_path.exists():
            raise FileNotFoundError(f"Missing file: {structure_path}")
        if not contents_path.exists():
            raise FileNotFoundError(f"Missing file: {contents_path}")

        structure = self.load_json(structure_path)
        contents = self.load_json(contents_path)

        # Validate
        self.validate_files(structure, contents)

        # Load data
        self.load_universe_config(structure, contents)
        self.load_universe_structure(structure)
        self.load_ports(contents)
        self.load_sector_contents(contents)

        # Verify
        self.verify_integrity(structure)

        # Print summary
        print("\n" + "=" * 60)
        print("🎉 Universe load complete!")
        print("=" * 60)
        print(f"Sectors loaded:         {self.stats['sectors_loaded']}")
        print(f"Ports loaded:           {self.stats['ports_loaded']}")
        print(f"Sector contents loaded: {self.stats['sector_contents_loaded']}")
        print("=" * 60)


def main():
    parser = argparse.ArgumentParser(description="Load universe data into Supabase")
    parser.add_argument(
        "--from-json",
        dest="data_dir",
        type=Path,
        required=True,
        help="Directory containing universe_structure.json and sector_contents.json",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force reload (truncate existing universe data)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate files without loading to database",
    )

    args = parser.parse_args()

    # Get Supabase credentials
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        print("❌ Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables required")
        print("   Set these in .env file or environment")
        sys.exit(1)

    print("=" * 60)
    print("🌌 Universe Data Loader for Supabase")
    print("=" * 60)
    print(f"Data directory: {args.data_dir}")
    print(f"Supabase URL:   {supabase_url}")
    print(f"Dry run:        {args.dry_run}")
    print(f"Force reload:   {args.force}")
    print("=" * 60)

    try:
        loader = UniverseLoader(supabase_url, supabase_key, dry_run=args.dry_run)

        # Check for existing data
        if not args.dry_run:
            existing = loader.check_existing_universe()
            if existing and not args.force:
                print("\n❌ Error: Universe data already exists in database")
                print("   Use --force to truncate and reload")
                sys.exit(1)
            elif existing and args.force:
                loader.truncate_universe()

        # Load universe
        loader.load(args.data_dir)

        print("\n✅ Success!")
        sys.exit(0)

    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
