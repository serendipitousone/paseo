# TWERK supply-chain hardening — building our Paseo fork

> This is **our** doc (the `twerk/*` branches), not upstream's. It governs how we install
> dependencies and build the Paseo daemon we deploy into TWERK environments. Lives with the
> code it governs so the policy travels with the fork.

## Why this exists

npm's lifecycle scripts (`preinstall` / `install` / `postinstall` / `prepare`) run arbitrary
code with the installing user's privileges the moment you `npm install`. That is the primary
RCE vector for the 2025–2026 npm supply-chain wave — the **Shai-Hulud** self-replicating worm
(~796 packages) and the **Sept-2025 hijack** (packages with ~2B weekly downloads) both executed
through install hooks. The mitigations below would have neutralized every major incident in that
window.

## The controls (defense in depth)

1. **Pinned source.** The fork tracks `getpaseo/paseo` as `upstream` and is pinned to an explicit
   release **tag** on a `twerk/*` branch. We never build from a floating `main`.
2. **Committed, integrity-enforced lockfile.** `package-lock.json` is committed at the tag; every
   *external* dependency carries an `integrity` SHA-512. `npm ci` fails closed if package.json and
   the lockfile disagree, so nothing is silently added or upgraded. (The only lockfile entries
   without an integrity hash are our own local `packages/*` workspace links — expected.)
3. **Lifecycle scripts blocked by default** — `.npmrc` sets `ignore-scripts=true`. Dependency
   install hooks never run. The one first-party postinstall (`scripts/postinstall-patches.mjs`)
   only patches two **React-Native mobile** packages and is **not** in the daemon build path, so
   the daemon build needs *no* scripts at all. If a future build genuinely needs a first-party
   script, run it **explicitly by hand after review**, never via auto-install.
4. **No auto-install of new packages.** We use `npm ci` (lockfile-exact), never bare `npm install`.
   `.npmrc` sets `save-exact=true` and `package-lock=true` so any deliberate addition is an exact
   pin, reviewed in a PR.
5. **Single canonical registry.** `.npmrc` pins `registry=https://registry.npmjs.org/` — no mirror
   that could serve a poisoned artifact.
6. **Release cooldown on upstream syncs.** Do not adopt a brand-new upstream release immediately.
   Wait **7–14 days** after an upstream tag before syncing to it, so a compromised transitive
   version has time to be caught and yanked. (npm has no native cooldown; this is a manual gate.)

## Build procedure (the daemon)

All npm commands use the Node 22 runtime the Paseo service runs on:

```bash
export PATH=/home/serendipity/.local/share/pi-node/node-v22.22.3-linux-x64/bin:$PATH
cd /mnt/shared/cto/paseo

# 1. Clean, deterministic, script-free install from the committed lockfile.
npm ci --ignore-scripts        # (redundant with .npmrc; kept explicit in CI)

# 2. CVE + provenance scan — fail the build on a real finding, don't auto-fix.
npm audit --audit-level=moderate
npm audit signatures           # verifies registry signatures + provenance attestations
osv-scanner scan source --lockfile=package-lock.json   # 2nd, registry-independent CVE check (OSV.dev)

# 3. Build ONLY the daemon stack (no app / Electron / Expo).
npm run build:server           # highlight -> relay -> protocol -> client -> server -> cli
```

`build:server` is pure `tsc` compilation across the daemon workspaces — it does not require any
dependency lifecycle script, which is why `ignore-scripts=true` is safe for it.

## Daemon bundle (self-contained, for the offline/egress-restricted sandbox)

The sandbox container downloads nothing, so we ship a self-contained, **daemon-only** bundle built
from OUR source (never the registry). Output dir: `.twerk-bundle/` (git-ignored; regenerate, don't
commit). Mechanism:

```bash
export PATH=/home/serendipity/.local/share/pi-node/node-v22.22.3-linux-x64/bin:$PATH
cd /mnt/shared/cto/paseo
# After Build procedure above (build:server done):
mkdir -p .twerk-bundle/tarballs
npm pack --ignore-scripts -w @getpaseo/highlight -w @getpaseo/relay -w @getpaseo/protocol \
  -w @getpaseo/client -w @getpaseo/server -w @getpaseo/cli --pack-destination .twerk-bundle/tarballs
# .twerk-bundle/app/package.json: depends on the cli tarball, with `overrides` forcing every
# @getpaseo/* to its local file: tarball (guarantees OUR build, not registry copies).
cd .twerk-bundle/app && npm install --omit=dev --ignore-scripts   # daemon prod closure only
cp -a /home/serendipity/.local/share/pi-node/node-v22.22.3-linux-x64 ../node   # bundled runtime
rm -rf ../node/lib/node_modules/@getpaseo ../node/lib/node_modules/@earendil-works ../node/lib/node_modules/pi*  # slim
```

Launch (`start-daemon.sh` in the bundle): runs `node app/node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js`
off the bundled Node, honoring `PASEO_HOME` / `PASEO_LISTEN`.

**Validated 2026-06-16 (tag v0.1.96):** boots in isolation on `127.0.0.1:6799`
("Server listening", WS `/ws` up); the bundled `@getpaseo/server` dist sha matches our source
build (`584d7d5c…`); closure contains `ws@8.21.0` and **no** app/Electron/Expo/Metro; size **~593 MB**
(Node ~200 MB + daemon prod closure ~392 MB).

### Two runtime out-bound behaviors to neutralize in the sandbox (the egress DROPs them)
The boot test surfaced two defaults that dial out at startup — both must be turned off in the
sandbox daemon's `$PASEO_HOME/config.json` (we reach the daemon via the Incus proxy / Direct path,
and the persona is chat/web-search only):
1. **Relay** — `daemon.relay.enabled` defaults `true`; the daemon dials `relay.paseo.sh`
   (`relay_control_connected`). Set `daemon.relay.enabled: false`.
2. **Local speech models** — voice/dictation default on, triggering a background download of
   `parakeet-*` + `kokoro-*` into `$PASEO_HOME/models`. Disable `features.voiceMode.enabled` and
   `features.dictation.enabled` (trims runtime egress and ~the speech model fetch).

### Maps to `incus file push` (next step, #275 provisioning)
Push `.twerk-bundle/{node,app,start-daemon.sh}` to a prefix in the container (e.g. `/opt/paseo/`),
write a `config.json` with relay+voice disabled into the in-container `$PASEO_HOME`, and add an
Incus **proxy device** forwarding the host/LAN port to the container's `PASEO_LISTEN`. `pi` is
already baked into the sandbox for the daemon to spawn (`pi --mode rpc`).

## Upstream sync procedure

```bash
git fetch upstream --tags
# Pick a tag that is >= 7-14 days old (cooldown). Review the diff, especially:
#   - package.json / package-lock.json dependency changes (new or bumped transitive deps)
#   - any new/changed files under scripts/ and patches/
git checkout twerk/main && git merge <tag>      # or rebase our thin diff onto the tag
# Re-run the full Build procedure above; treat any new audit finding as a release blocker.
```

Our divergence from upstream is intentionally thin (this doc + `.npmrc` today). Keep it that way
so syncs stay a clean review, and so functional forks (later #274 sub-issues) are isolated on
their own `twerk/<feature>` branches.

## Tooling

- **`osv-scanner` v2.3.8** — **installed** at `~/.local/bin/osv-scanner`, the linux_amd64 release
  binary verified against the release `osv-scanner_SHA256SUMS`
  (`bc98e1…92dc`). Standalone Go binary, *not* an npm package, so it adds no npm supply-chain
  surface. Runs as the second, registry-independent CVE check in the build procedure above.

## Recommended additions (not yet wired)

- **SBOM generation** (`npm sbom --sbom-format cyclonedx`) committed per release tag for audit trail.
- **CI gate**: run the Build procedure + scans in GitHub Actions on every `twerk/*` push so the
  controls are enforced mechanically, not by memory.

## What we deliberately do NOT do

- We do **not** run `npm audit fix --force` — it floats versions off the lockfile, the opposite of
  pinning. Findings are triaged and fixed deliberately.
- We do **not** install the full app/Electron/Expo native toolchain for a daemon build.
- We do **not** trust a release the day it ships (see cooldown).

## Latest scan results — tag `v0.1.96`, 2026-06-16 (node 22.22.3 / npm 10.9.8)

**Install:** `npm ci --ignore-scripts` → 2611 packages, exit 0, **no lifecycle scripts executed.**

**Supply-chain integrity — `npm audit signatures`: PASS.**
- 2600 / 2600 registry packages have **verified registry signatures** (0 failures).
- 313 packages have **verified provenance attestations.**
- (The 11-package delta vs. install count is our own local `packages/*` workspace links — unsigned by design.)
- Interpretation: every installed artifact cryptographically matches the registry's signed record —
  no injected/tampered package of the Shai-Hulud class is present in the pinned tree.

**Known-CVE audit (`npm audit`) — a separate risk class (pinned versions with published advisories,
NOT injection):**
- Whole monorepo: 87 (6 low / 49 moderate / 26 high / 6 critical). **All 6 criticals are in the
  app / Electron / Expo / Metro / Cloudflare / eas-cli toolchain — none of which ships in the daemon.**
- **Daemon production tree only** (`--omit=dev --workspace=@getpaseo/server --workspace=@getpaseo/cli`):
  **13 (3 low / 6 moderate / 4 high / 0 critical)** after the `ws` fix below — down from 17.
  Remaining are moderate/low-exploitability in our context (`uuid` <11.1.1 moderate/breaking,
  `qs`/`express`/`picomatch` transitive). Triage deliberately; no `audit fix --force`.
- **Applied fix:** `ws` bumped **8.20.0 → 8.21.0** across the daemon (cleared GHSA-58qx /
  GHSA-96hv highs). Done via `npm update ws --ignore-scripts --legacy-peer-deps` — within the
  existing `^8.14.2` range, so package.json is unchanged; only the lockfile moved (0 top-level
  packages removed, 35 deduped nested copies). The app-tree `ws@6/7` moved to patched 6.2.4 / 7.5.11.
- Exploitability context: the daemon is reached only by Bo's Paseo client over a Direct
  Tailscale/LAN connection and is not internet-exposed.

**osv-scanner cross-check:** no daemon-path findings beyond the npm-audit set; the only residual
`ws@8.18.0` finding is app-tree, not shipped in the daemon bundle.

**Daemon build:** `npm run build:server` — compiles clean under `ignore-scripts=true` (pure `tsc`,
no dependency script needed), re-verified after the `ws` bump.
