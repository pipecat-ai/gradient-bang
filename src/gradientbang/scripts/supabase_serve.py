"""Run Supabase edge functions with local project defaults."""

from __future__ import annotations

import os
import sys


def main() -> None:
    args = [
        "npx",
        "supabase",
        "functions",
        "serve",
        "--workdir",
        "deployment",
        "--no-verify-jwt",
        "--env-file",
        ".env.supabase",
        *sys.argv[1:],
    ]
    os.execvp(args[0], args)
