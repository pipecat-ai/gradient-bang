import asyncio
import json
from pathlib import Path
from datetime import datetime, timezone
from typing import Dict, Any, Optional


class MessageStore:
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)
        (self.base_dir / "inbox").mkdir(parents=True, exist_ok=True)
        (self.base_dir / "checkpoints").mkdir(parents=True, exist_ok=True)
        self.seq_file = self.base_dir / "seq.txt"
        self.lock = asyncio.Lock()

    async def next_id(self) -> int:
        last = 0
        if self.seq_file.exists():
            try:
                last = int(self.seq_file.read_text().strip() or 0)
            except Exception:
                last = 0
        last += 1
        tmp = self.seq_file.with_suffix(".tmp")
        tmp.write_text(str(last))
        tmp.replace(self.seq_file)
        return last

    def now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    async def append(self, *, from_id: str, from_name: str, msg_type: str, content: str, to_name: Optional[str] = None, to_character_id: Optional[str] = None) -> Dict[str, Any]:
        async with self.lock:
            mid = await self.next_id()
            rec: Dict[str, Any] = {
                "id": mid,
                "timestamp": self.now_iso(),
                "type": msg_type,
                "from_character_id": from_id,
                "from_name": from_name,
                "content": content,
            }
            if msg_type == "direct" and to_name:
                rec["to_name"] = to_name
            line = json.dumps(rec)
            if msg_type == "broadcast":
                with (self.base_dir / "broadcast.jsonl").open("a") as f:
                    f.write(line + "\n")
            else:
                # Use character ID for inbox filename (stable, unique, filesystem-safe)
                inbox_key = to_character_id if to_character_id else to_name
                inbox = self.base_dir / "inbox" / f"{inbox_key}.jsonl"
                with inbox.open("a") as f:
                    f.write(line + "\n")
            return rec
