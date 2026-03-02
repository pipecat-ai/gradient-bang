{ pkgs ? import <nixpkgs> {} }:

let
  # Pinned nixpkgs for Deno 2.6.10 (needed for `deno run --coverage`)
  denoPkgs = import (fetchTarball
    "https://github.com/NixOS/nixpkgs/archive/80d901ec0377e19ac3f7bb8c035201e2e098cc97.tar.gz"
  ) { };
in

pkgs.mkShell {
  buildInputs = with pkgs; [
    python313
    uv
    nodejs_22
    libGL
    glib
    pnpm
    denoPkgs.deno
  ];

  shellHook = ''
    export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath [
      pkgs.libGL
      pkgs.glib
      pkgs.stdenv.cc.cc.lib
    ]}:$LD_LIBRARY_PATH"
    export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
  '';
}
