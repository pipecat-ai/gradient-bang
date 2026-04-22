from importlib.metadata import PackageNotFoundError, version as _pkg_version


def _read_version() -> str:
    try:
        return _pkg_version("gradient-bang")
    except PackageNotFoundError:
        pass

    import tomllib
    from pathlib import Path

    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "pyproject.toml"
        if candidate.exists():
            with candidate.open("rb") as f:
                return tomllib.load(f)["project"]["version"]
    return "0.0.0-dev"


__version__ = _read_version()
