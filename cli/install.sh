#!/usr/bin/env bash
# Install Glueva and its paired plugins from a checksummed GitHub release.

set -euo pipefail

repo="${GLUEVA_REPO:-shadowofdoom/glueva}"
version="latest"
install_dir="${HOME}/.local/bin"
install_plugins=1
use_gh=0

usage() {
  printf '%s\n' \
    'Usage: install.sh [--version VERSION] [--install-dir PATH] [--repo OWNER/REPO] [--cli-only]' \
    '' \
    'Installs the standalone CLI and both marketplace plugins. Uses authenticated' \
    '`gh release download` when available,' \
    'with a public GitHub download fallback. --cli-only skips plugin setup.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version="${2:?--version requires a value}"; shift 2 ;;
    --install-dir) install_dir="${2:?--install-dir requires a value}"; shift 2 ;;
    --repo) repo="${2:?--repo requires a value}"; shift 2 ;;
    --cli-only) install_plugins=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'glueva installer: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  use_gh=1
fi

if [ "${install_plugins}" -eq 1 ]; then
  command -v claude >/dev/null 2>&1 || {
    printf 'glueva installer: Claude Code is required; install it first or pass --cli-only\n' >&2
    exit 1
  }
  command -v codex >/dev/null 2>&1 || {
    printf 'glueva installer: Codex is required; install it first or pass --cli-only\n' >&2
    exit 1
  }
fi

case "$(uname -s)" in
  Darwin) platform="darwin"; extension="tar.gz"; binary="glueva" ;;
  Linux) platform="linux"; extension="tar.gz"; binary="glueva" ;;
  MINGW*|MSYS*|CYGWIN*) platform="windows"; extension="zip"; binary="glueva.exe" ;;
  *) printf 'glueva installer: unsupported operating system: %s\n' "$(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) architecture="arm64" ;;
  x86_64|amd64) architecture="x64" ;;
  *) printf 'glueva installer: unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac

if [ "${version}" = "latest" ]; then
  if [ "${use_gh}" -eq 1 ]; then
    tag="$(gh release list --repo "${repo}" --limit 100 --json tagName,isDraft \
      --jq 'map(select(.isDraft == false and (.tagName | startswith("v"))))[0].tagName')"
    [ -n "${tag}" ] || { printf 'glueva installer: no Glueva release found in %s\n' "${repo}" >&2; exit 1; }
  else
    effective="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${repo}/releases/latest")"
    tag="${effective##*/}"
    case "${tag}" in
      v*) ;;
      *) printf 'glueva installer: cannot discover a public release; install/authenticate gh or pass --version\n' >&2; exit 1 ;;
    esac
  fi
else
  case "${version}" in
    v*) tag="${version}" ;;
    *) tag="v${version}" ;;
  esac
fi

release_version="${tag#v}"
case "${release_version}" in
  ""|*[!0-9A-Za-z.+-]*)
    printf 'glueva installer: invalid release version: %s\n' "${release_version}" >&2
    exit 1
    ;;
esac
archive="glueva-${release_version}-${platform}-${architecture}.${extension}"
tmp="$(mktemp -d)"
staged=""
cleanup() {
  rm -rf "${tmp}"
  [ -z "${staged}" ] || rm -f "${staged}"
}
trap cleanup EXIT

if [ "${use_gh}" -eq 1 ]; then
  gh release download "${tag}" --repo "${repo}" --dir "${tmp}" \
    --pattern "${archive}" --pattern checksums.txt
else
  base="https://github.com/${repo}/releases/download/${tag}"
  curl -fL "${base}/${archive}" -o "${tmp}/${archive}"
  curl -fL "${base}/checksums.txt" -o "${tmp}/checksums.txt"
fi

expected="$(awk -v file="${archive}" '$2 == file { print $1 }' "${tmp}/checksums.txt")"
[ -n "${expected}" ] || { printf 'glueva installer: checksum is missing for %s\n' "${archive}" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp}/${archive}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmp}/${archive}" | awk '{print $1}')"
elif command -v openssl >/dev/null 2>&1; then
  actual="$(openssl dgst -sha256 "${tmp}/${archive}" | awk '{print $NF}')"
else
  printf 'glueva installer: sha256sum, shasum, or openssl is required for verification\n' >&2
  exit 1
fi
[ "${actual}" = "${expected}" ] || { printf 'glueva installer: checksum mismatch for %s\n' "${archive}" >&2; exit 1; }

mkdir -p "${tmp}/unpacked" "${install_dir}"
if [ "${extension}" = "zip" ]; then
  command -v unzip >/dev/null 2>&1 || { printf 'glueva installer: unzip is required on Windows\n' >&2; exit 1; }
  unzip -q "${tmp}/${archive}" -d "${tmp}/unpacked"
else
  tar -xzf "${tmp}/${archive}" -C "${tmp}/unpacked"
fi

staged="${install_dir}/.${binary}.tmp.$$"
cp "${tmp}/unpacked/${binary}" "${staged}"
chmod +x "${staged}" 2>/dev/null || true
installed_version="$("${staged}" --version)"
[ "${installed_version}" = "${release_version}" ] || {
  printf 'glueva installer: installed binary reports version %s, expected %s\n' "${installed_version}" "${release_version}" >&2
  exit 1
}
mv "${staged}" "${install_dir}/${binary}"
staged=""
printf 'Installed Glueva %s to %s\n' "${release_version}" "${install_dir}/${binary}"

if [ "${install_dir}" = "${HOME}/.local/bin" ]; then
  case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *)
      case "${SHELL##*/}" in
        zsh)
          profile="${ZDOTDIR:-${HOME}}/.zshrc"
          path_line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
        bash)
          if [ "${platform}" = "darwin" ]; then
            if [ -f "${HOME}/.bash_profile" ]; then
              profile="${HOME}/.bash_profile"
            elif [ -f "${HOME}/.bash_login" ]; then
              profile="${HOME}/.bash_login"
            elif [ -f "${HOME}/.profile" ]; then
              profile="${HOME}/.profile"
            else
              profile="${HOME}/.bash_profile"
            fi
          else
            profile="${HOME}/.bashrc"
          fi
          path_line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
        fish)
          profile="${HOME}/.config/fish/config.fish"
          path_line='fish_add_path "$HOME/.local/bin"'
          ;;
        *)
          profile="${HOME}/.profile"
          path_line='export PATH="$HOME/.local/bin:$PATH"'
          ;;
      esac
      mkdir -p "$(dirname "${profile}")"
      touch "${profile}"
      grep -Fqx "${path_line}" "${profile}" || printf '\n%s\n' "${path_line}" >> "${profile}"
      export PATH="${install_dir}:${PATH}"
      printf 'Added %s to PATH in %s; restart your shell to apply it.\n' "${install_dir}" "${profile}"
      ;;
  esac
fi

json_has_string() {
  key="$1"
  value="$2"
  json="$3"
  compact="$(printf '%s' "${json}" | tr -d '[:space:]')"
  case "${compact}" in
    *\"${key}\":\"${value}\"*) return 0 ;;
    *) return 1 ;;
  esac
}

install_claude_plugin() {
  marketplaces="$(claude plugin marketplace list --json)"
  if json_has_string name glueva "${marketplaces}"; then
    claude plugin marketplace update glueva
  else
    claude plugin marketplace add "${repo}"
  fi

  plugins="$(claude plugin list --json)"
  if json_has_string id glueva@glueva "${plugins}"; then
    claude plugin update glueva@glueva --scope user
  else
    claude plugin install glueva@glueva --scope user
  fi
}

install_codex_plugin() {
  marketplaces="$(codex plugin marketplace list --json)"
  if json_has_string name glueva-codex "${marketplaces}"; then
    codex plugin marketplace upgrade glueva-codex
  else
    codex plugin marketplace add "${repo}"
  fi

  plugins="$(codex plugin list --json)"
  if json_has_string pluginId glueva@glueva-codex "${plugins}"; then
    printf '%s\n' 'Glueva Codex plugin is already installed; the refreshed marketplace will apply on restart.'
  else
    codex plugin add glueva@glueva-codex
  fi
}

if [ "${install_plugins}" -eq 1 ]; then
  install_claude_plugin
  install_codex_plugin
  printf '%s\n' \
    'Installed the paired Claude Code and Codex plugins.' \
    'Restart both CLIs, then run `glueva codex` followed by `glueva claude` in your project.' \
    'Later, run `glueva update` to update or `glueva uninstall` to remove Glueva.'
fi
