"""Wrapper for `npx supabase functions serve` with project defaults."""

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
