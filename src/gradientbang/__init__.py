from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("gradient-bang")
except PackageNotFoundError:
    __version__ = "0.0.0-dev"
