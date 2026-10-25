#!/bin/sh
# Runs the test suite against several OTP releases using nix.
# Usage: scripts/test-otp.sh [23 24 25 26 27 28 29]
# OTP 23 depends on OpenSSL 1.1, which nixpkgs marks insecure; it is allowed
# for that run only. Mix and Hex state goes to ~/.cache/erlnode, not ~/.mix.
set -u
cd "$(dirname "$0")/.."

# Each release gets its own Mix and Hex homes: Hex archives are compiled for
# one OTP release, and sharing ~/.mix between releases breaks them.
run() { # otp nixpkgs elixir-attribute [hex-version]
  printf 'OTP %s: ' "$1"
  home="${XDG_CACHE_HOME:-$HOME/.cache}/erlnode/otp-$1"
  HEX_VERSION="${4:-}" MIX_HOME="$home/mix" HEX_HOME="$home/hex" MIX_INSTALL_DIR="$home/installs" \
  NIXPKGS_ALLOW_INSECURE=1 nix shell --impure \
    "$2#beam.packages.erlang_$1.$3" "$2#beam.interpreters.erlang_$1" \
    -c sh -c 'test -d "$MIX_HOME/archives" || mix local.hex $HEX_VERSION --force >/dev/null; bun test' \
    2>&1 | grep -E '^ *[0-9]+ (pass|fail)|\(fail\)' | tr '\n' ' '
  echo
}

for otp in ${@:-23 24 25 26 27 28 29}; do
  case $otp in
    23) run 23 github:NixOS/nixpkgs/nixos-23.05 elixir_1_14 2.1.1 ;; # current Hex needs OTP 24+
    24) run 24 github:NixOS/nixpkgs/nixos-24.05 elixir_1_14 ;;
    25) run 25 github:NixOS/nixpkgs/nixos-24.05 elixir_1_14 ;;
    26) run 26 github:NixOS/nixpkgs/nixos-24.05 elixir_1_15 ;;
    27) run 27 nixpkgs elixir_1_18 ;;
    28) run 28 nixpkgs elixir_1_18 ;;
    29) run 29 nixpkgs elixir ;;
    *) echo "unknown OTP release $otp" ;;
  esac
done
