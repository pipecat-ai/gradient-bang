import runpy


def main():
    """Entry point for `uv run bot` and `python -m gradientbang`.

    Pipecat's runner discovers the per-session `bot()` function by inspecting
    `sys.modules["__main__"]`. Console scripts make __main__ the wrapper, not
    our bot module — so we use runpy to re-exec bot.py with __name__ ==
    "__main__", letting its bottom `if __name__ == "__main__":` block hand
    control to pipecat.runner.run.main().
    """
    runpy.run_module("gradientbang.bot", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main()
