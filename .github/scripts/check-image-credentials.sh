#!/usr/bin/env bash
# Fails when a built image holds credential files, secret-named settings or
# token-shaped strings. It prints paths and variable names, never values.
# Usage: check-image-credentials.sh <image>
set -euo pipefail

# Files that hold credentials at runtime or in a developer checkout.
readonly FILE_PATTERN='(^|/)(\.env(\.[^/]*)?|\.npmrc|\.netrc|\.git|\.ssh|\.docker/config\.json|id_(rsa|ecdsa|ed25519))(/|$)|^config/.|^app/.*\.(pem|key|p12|pfx)$'
# Dependencies ship their own fixtures, and .env.example holds no values.
readonly IGNORED_PATHS='(^|/)node_modules/|(^|/)\.env\.example$'
readonly SECRET_NAME='TOKEN|SECRET|PASSWORD|PASSWD|_PASS|API_?KEY|PRIVATE_?KEY|CREDENTIAL'
# GitHub tokens, Discord bot tokens and PEM private keys.
readonly TOKEN_SHAPE='gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

# Set by check_files, removed by cleanup on every exit path.
scratch_container=''
scratch_listing=''

fail() {
    echo "check-image-credentials: $1" >&2
    exit 1
}

cleanup() {
    [ -z "$scratch_container" ] || docker rm -f "$scratch_container" >/dev/null
    [ -z "$scratch_listing" ] || rm -f "$scratch_listing"
}

# No credential file may exist anywhere in the image filesystem.
check_files() {
    local image="$1" hits
    scratch_listing="$(mktemp)"
    scratch_container="$(docker create "$image")"
    docker export "$scratch_container" | tar -tf - >"$scratch_listing"
    [ -s "$scratch_listing" ] || fail "could not list the files of $image"
    hits="$(grep -v -E "$IGNORED_PATHS" "$scratch_listing" | grep -E "$FILE_PATTERN" || true)"
    if [ -n "$hits" ]; then
        printf '%s\n' "$hits" >&2
        fail "credential files found in $image"
    fi
}

# No secret-named variable may be set, and no build step may carry a token.
check_config() {
    local image="$1" names history
    names="$(docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
        grep -E '^[^=]+=.+' | cut -d= -f1 | grep -i -E "$SECRET_NAME" || true)"
    if [ -n "$names" ]; then
        printf '%s\n' "$names" >&2
        fail "secret-named environment variables are set in $image"
    fi
    history="$(docker history --no-trunc --format '{{.CreatedBy}}' "$image")"
    [ -n "$history" ] || fail "could not read the build history of $image"
    if printf '%s\n' "$history" | grep -q -i -E "(ARG|ENV) [A-Z0-9_]*($SECRET_NAME)"; then
        fail "a secret-named build argument is recorded in the history of $image"
    fi
    if { docker image inspect --format '{{json .Config}}' "$image"; printf '%s\n' "$history"; } |
        grep -q -E -e "$TOKEN_SHAPE"; then
        fail "a token-shaped value is recorded in the config or history of $image"
    fi
}

# No application file may contain a token-shaped string.
check_contents() {
    local image="$1" hits status=0
    hits="$(docker run --rm --network none --entrypoint grep "$image" \
        -rIlE --exclude-dir=node_modules -e "$TOKEN_SHAPE" /app)" || status=$?
    # grep exits 1 when nothing matches. Any other failure is an error.
    [ "$status" -le 1 ] || fail "could not scan the files of $image"
    if [ -n "$hits" ]; then
        printf '%s\n' "$hits" >&2
        fail "token-shaped strings found in $image"
    fi
}

main() {
    if [ "$#" -ne 1 ] || [ -z "$1" ]; then
        echo "Usage: $0 <image>" >&2
        exit 2
    fi
    docker image inspect "$1" >/dev/null 2>&1 || fail "image not found: $1"
    trap cleanup EXIT
    check_files "$1"
    check_config "$1"
    check_contents "$1"
    echo "check-image-credentials: $1 holds no credentials"
}

main "$@"
