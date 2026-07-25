<p align="center">
  <img src="assets/brand/opencode-multi-ai-lockup.png" alt="opencode-multi-ai" width="520">
</p>

<h1 align="center">opencode-multi-ai</h1>

<p align="center">
  One <a href="https://opencode.ai">OpenCode</a> plugin that pools <strong>SuperGrok (xAI)</strong>, <strong>ChatGPT / Codex</strong>, and <strong>Kiro (AWS CodeWhisperer)</strong> accounts behind sticky rotation, live quota visibility, and a tabbed terminal manager.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#add-accounts">Add accounts</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#tui">TUI</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

## Why

Subscription coding plans run out mid-task. This plugin keeps every account you already pay for in a single pool, picks one per request, and rotates automatically when a token dies, a quota resets, or a request hits a transient failure — without leaking credentials into OpenCode's `auth.json` or across provider boundaries.

- **One plugin line** registers all three providers.
- **One account file** (`multi-ai-accounts.json`, mode `600`) holds every account, tagged by provider, with per-provider sticky selection.
- **Rotation is failure-driven** — auth failures, quota exhaustion, and retryable errors rotate; genuine client errors (bad params) do not.
- **Quota is visible** where you work: in the CLI, in the TUI, and in the OpenCode session sidebar.

## Providers at a glance

| | xAI | Codex | Kiro |
| --- | --- | --- | --- |
| Provider ID | `xai-multi` | `codex-multi` | `kiro-multi` |
| Display name | Grok Multi-Account | Codex Multi-Account | Kiro Multi-Account |
| Auth | SuperGrok OAuth (device / browser) | ChatGPT OAuth (device / browser) · OAuth JSON import | AWS Builder ID / IAM Identity Center · `ksk_` API key · JSON / kiro-cli / legacy DB import |
| Runtime | `@ai-sdk/xai`, host-pinned fetch | `@ai-sdk/openai`, rewritten to `chatgpt.com/backend-api` | `@ai-sdk/openai-compatible` over a **custom** CodeWhisperer SDK transport |
| Quota surfaced | Plan, billing credits %, rate-limit headers | Primary / secondary usage windows, plan type, reset times | `usedCount` / `limitCount`, region-aware endpoints |
| Forced CLI | `op-xai` | `op-codex` | `op-kiro` |

Tabs, and the CLI default, are ordered **Codex → xAI → Kiro**.

## Requirements

- [OpenCode](https://opencode.ai) 1.17.x
- Node.js 20+ or [Bun](https://bun.sh) (Bun preferred — the package ships TypeScript, no build step)
- At least one SuperGrok, ChatGPT/Codex, or Kiro subscription account

## Install

### One command

```bash
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-ai/main/install.sh | bash -s -- --path --with-plugin
```

| Variant | Effect |
| --- | --- |
| `\| bash` | CLI shims only |
| `\| bash -s -- --path` | Shims + add `~/.local/bin` to your shell PATH |
| `\| bash -s -- --path --with-plugin` | Also wire OpenCode providers and the plugin entry |
| `\| bash -s -- --path --force` | Re-clone / reset the install directory |

The installer clones to `~/.local/share/opencode-multi-ai` (override with `MULTI_AI_HOME`), installs dependencies, drops CLI shims into `~/.local/bin` (`MULTI_AI_BIN_DIR`), and with `--with-plugin` runs `scripts/install.ts --with-plugin-entry`.

Open a new terminal afterwards, or `source ~/.zshrc`.

### From a clone

```bash
git clone https://github.com/zane-tv/opencode-multi-ai.git
cd opencode-multi-ai
./install.sh --path        # same as: npm run setup

npm run install-cli        # shims only
npm run install:global     # shims + PATH
```

### Wire the plugin into OpenCode

A single plugin path loads all three providers — the package root re-exports `xai`, `codex`, and `kiro`.

```bash
bun scripts/install.ts --with-plugin-entry
# target a different config:
bun scripts/install.ts --with-plugin-entry --config ~/.config/opencode/opencode.json
```

`install.ts` merges idempotently: it registers all three providers, writes one package-root plugin path (collapsing older per-module paths), replaces legacy `opencode-multi-xai` / `opencode-multi-codex` entries, backs up `opencode.json` to `.bak` once, preserves unrelated plugins and the built-in `xai` / `openai` providers, and only fills fields you have not set yourself.

Equivalent manual config in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["/absolute/path/to/opencode-multi-ai"],
  "provider": {
    "xai-multi": {
      "npm": "@ai-sdk/xai",
      "name": "Grok Multi-Account",
      "options": { "baseURL": "https://api.x.ai/v1" }
    },
    "codex-multi": {
      "npm": "@ai-sdk/openai",
      "name": "Codex Multi-Account",
      "options": {
        "baseURL": "https://chatgpt.com/backend-api",
        "store": false,
        "include": ["reasoning.encrypted_content"]
      }
    },
    "kiro-multi": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro Multi-Account",
      "options": {
        "baseURL": "https://q.us-east-1.amazonaws.com",
        "accountSelectionStrategy": "sticky"
      }
    }
  }
}
```

Restart OpenCode after any config change.

### Session sidebar (optional)

OpenCode's right-hand session sidebar is a separate plugin surface, registered in `tui.json`:

```bash
bun scripts/install-tui.ts     # or: npm run install-tui
```

After restart an **Accounts** section appears below Context / MCP / LSP / Models, showing only the sticky account per provider with a colored meter and remaining percentage:

```
★ Codex  work@example.com · Plus      ███████░░░  68%
★ xAI    grok-a · SuperGrok           █████░░░░░  51%
★ Kiro   team@example.com · Pro       ████████░░  79%
```

Change which account is sticky with `op-ai tui` → `s`.

## Add accounts

### From inside OpenCode

1. Restart OpenCode after installing.
2. Run `opencode auth login`.
3. Pick `xai-multi`, `codex-multi`, or `kiro-multi`.
4. Choose an auth method.

Kiro exposes seven methods: **Kiro API Key**, **AWS Builder ID / IAM Identity Center**, **IAM Identity Center with Profile ARN**, **Import account from credentials JSON**, **Import accounts from Kiro Account Manager export**, **Import from kiro-cli DB**, and **Import from legacy kiro.db**. Start URL, SSO region, and Profile ARN are remembered between logins (see [Kiro defaults](#kiro-defaults)).

### From the CLI

```bash
op-ai add --provider xai            # device OAuth
op-ai add --provider codex --browser
op-codex import --file ~/.codex/auth.json

op-kiro add --api-key ksk_xxx --region us-east-1
op-kiro add --start-url https://acme.awsapps.com/start --idc-region eu-central-1
op-kiro add --profile-arn arn:aws:codewhisperer:eu-central-1:…:profile/XXXX
op-kiro import --kiro-cli
op-kiro import --legacy-db
```

xAI and Codex accept OAuth only — no raw API keys go into the pool. Kiro accepts `ksk_` keys because that is its native credential format.

## CLI

`op-ai` covers all providers; `op-xai` / `op-codex` / `op-kiro` force one. The bin name wins over `--provider`. Mutating commands on `op-ai` require `--provider xai|codex|kiro`; `help`, `tui`, `status`, and `list` do not.

```bash
op-ai                          # TUI (default command)
op-ai list
op-ai status
op-ai limits --probe
op-ai health
op-ai switch --id a1b2
op-ai priority --index 2 --direction top
op-ai prune --execute
op-ai help
```

| Command | Options | Purpose |
| --- | --- | --- |
| `tui` | `--lang en\|vi`, `--provider` | Tabbed account manager (default command) |
| `status` | `--provider` | Compact pool state per provider |
| `list` | `--tag`, `--provider` | Accounts, health, sticky marker |
| `add` | `--browser`; Kiro: `--api-key`, `--region`, `--start-url`, `--idc-region`, `--profile-arn` | Add an account |
| `import` | Codex: `--file`, `--json`; Kiro: `--file`, `--json`, `--api-key`, `--export-json`, `--kiro-cli[-path]`, `--legacy-db`, `--skip-validate` | Import existing credentials |
| `limits` / `quota` | `--probe`, `--index`, `--id` | Quota and usage windows |
| `health` | — | Force-refresh and validate every account |
| `switch` | `--index` \| `--id` | Set the sticky account |
| `enable` / `disable` | `--index` \| `--id` | Include / exclude from selection |
| `refresh` | `--index` \| `--id` | Force a token refresh |
| `priority` | `--index`, `--direction up\|down\|top` \| `--priority N` | Reorder rotation preference |
| `label` / `tag` / `note` | `--index`, `--label` / `--tags` / `--note` | Annotate an account |
| `flag` / `unflag` | `--index` \| `--id` | Mark / unmark for pruning |
| `remove` | `--index` \| `--id`, `--confirm` | Delete one account |
| `prune` | `--tag`, `--execute` | Remove dead **or** flagged accounts (dry-run by default) |
| `clean-dead` | `--execute` | Remove only dead accounts (dry-run by default) |

Bin aliases `opencode-multi-ai`, `opencode-multi-xai`, `opencode-multi-codex`, `xai-multi`, `codex-multi`, and `kiro-multi` all resolve to the same CLI, forcing a provider where the name implies one.

> `opencode xai-add` and `opencode codex-add` do **not** work — OpenCode reads those as project paths. Use `op-ai` or the in-session agent tools.

### Agent tools

Every provider registers the same 17 pool-management tools plus its own quota tool, so an agent can inspect and repair the pool mid-session: `{provider}-status`, `-list`, `-add`, `-switch`, `-priority`, `-remove`, `-enable`, `-disable`, `-label`, `-tag`, `-note`, `-refresh`, `-health`, `-flag`, `-unflag`, `-prune`, `-clean-dead`, plus `xai-limits`, `codex-limits`, `kiro-limits`, `codex-import`, and `kiro-import`.

## TUI

```bash
op-ai tui                     # opens on Codex
op-ai tui --provider kiro
op-kiro tui                   # forced
```

Layout: tab bar → account list → action menu (its own bordered pane) → status footer. Mouse clicks work on both accounts and action rows.

| Key | Action |
| --- | --- |
| `Tab` · `1` `2` `3` | Next tab · Codex · xAI · Kiro |
| `↑` `↓` / mouse | Move selection |
| `s` | Make sticky (active) |
| `e` / `d` | Enable / disable |
| `[` `]` `{` | Priority up / down / top |
| `l` `t` `n` | Label / tags / note |
| `f` / `u` | Flag / unflag for pruning |
| `x` `p` `P` | Remove / prune / clean-dead (each needs a second press) |
| `r` / `R` | Refresh selected / refresh all on this tab |
| `v` / `L` | Toggle live quota polling / reload pool from disk |
| `m` | Cycle selection strategy (sticky → round-robin → lowest-usage) |
| `F` | Toggle Codex Fast (`service_tier=fast`) |
| `g` | Toggle language (EN ↔ VI) |
| `?` · `q` / `Esc` | Help · quit / cancel |

Add keys are provider-aware:

| Key | Codex | xAI | Kiro |
| --- | --- | --- | --- |
| `a` / `+` | Device OAuth | Device OAuth | Builder ID / IDC login |
| `A` | Browser OAuth | Browser OAuth | Builder ID / IDC login |
| `o` | OAuth JSON import | — | Credentials JSON import |
| `i` `I` | — | — | API key · IDC + Profile ARN |
| `O` `c` | — | — | Account Manager export · kiro-cli DB |

## How selection works

1. **Sticky first.** Each provider keeps its own active account; requests reuse it while it stays healthy.
2. **On failure, rescan.** The pool is walked in priority order (priority descending, then last-used / added-at tiebreakers) and the first eligible account takes over.
3. **Rotate on the right signals only.** Auth failures, quota exhaustion, and retryable transport errors rotate. Unknown client errors and plain parameter 4xx do not — rotating there would just burn accounts on a bad request.
4. **Dead is narrow.** An account is marked dead only when a refresh returns `invalid_grant`. Quota exhaustion, usage limits, and post-refresh inference 401s never mark an account dead, and pruning only touches dead or explicitly flagged accounts.
5. **Selection strategy** is `sticky` by default; `round-robin` and `lowest-usage` are available (`m` in the TUI, or `accountSelectionStrategy` for Kiro).

When every account for a provider is exhausted, the plugin returns a 503 whose message includes recognizable quota phrasing so OpenCode's model fallback still triggers.

Providers never share credentials or sticky state, xAI bearers are only ever sent to `api.x.ai`, and tokens are never written to `auth.json` or to logs.

## Configuration

### Files

| Path (under `~/.config/opencode/`) | Purpose |
| --- | --- |
| `multi-ai-accounts.json` | Unified account pool, v3, mode `600` |
| `multi-ai-settings.json` | Locale and Kiro defaults |
| `multi-ai-models-xai.json` | xAI model cache |
| `multi-ai-models-codex.json` | Codex model cache |
| `multi-ai-models-kiro.json` | Kiro model cache |

Model catalogs sync over the network only after a successful login, never on cold start.

### Environment

| Variable | Purpose |
| --- | --- |
| `MULTI_AI_LANG` | UI locale `en` \| `vi` (legacy `MULTI_XAI_LANG` / `MULTI_CODEX_LANG` still read) |
| `MULTI_AI_SETTINGS_PATH` | Alternate settings file |
| `MULTI_AI_BIN_DIR` | Shim install directory |
| `MULTI_AI_HOME` | Install root for the curl installer |
| `MULTI_AI_REPO_URL` / `MULTI_AI_REPO_REF` | Clone source and ref |
| `OPENCODE_CONFIG` | Alternate `opencode.json` for `scripts/install.ts` |
| `MULTI_AI_KIRO_IDC_START_URL` | Default IAM Identity Center start URL |
| `MULTI_AI_KIRO_IDC_REGION` | Default SSO region |
| `MULTI_AI_KIRO_IDC_PROFILE_ARN` | Default Profile ARN |
| `MULTI_AI_KIRO_DEFAULT_REGION` | Default CodeWhisperer region (falls back to `us-east-1`) |

`lib/core/settings-inventory.ts` holds the authoritative inventory.

### Kiro defaults

Start URL, SSO region, and Profile ARN resolve in order: environment variable → `multi-ai-settings.json` (nested `kiro` object, then root) → legacy `~/.config/opencode/kiro.json` → the active profile in your kiro-cli database. Login prompts show the remembered value so you can press Enter to keep it.

Imports read from platform defaults: kiro-cli at `~/Library/Application Support/kiro-cli/data.sqlite3` (macOS), `%APPDATA%/kiro-cli/data.sqlite3` (Windows), or `$XDG_DATA_HOME/kiro-cli/data.sqlite3` (Linux); the legacy store at `~/.config/opencode/kiro.db`. Imported accounts are enriched afterwards — token refresh, usage probe, real email recovered from the ID token — so they show up with a meaningful label and quota instead of a placeholder.

### Kiro models and effort

Six thinking models are exposed: `claude-sonnet-5-thinking`, `claude-opus-5-thinking`, `claude-opus-4-8-thinking`, `gpt-5.6-sol-thinking`, `gpt-5.6-terra-thinking`, `gpt-5.6-luna-thinking`. Each publishes `low` / `medium` / `high` / `max` thinking-budget variants (8k / 16k / 24k / 32k), and reasoning effort is derived from the requested budget — or set explicitly with an `-low` … `-max` suffix on the model id.

## Migration from multi-xai / multi-codex

On first load, legacy pools are imported into `multi-ai-accounts.json`:

- `~/.config/opencode/multi-xai-accounts.json`
- `~/.config/opencode/multi-codex-accounts.json`

The import is idempotent, never clobbers an account the new pool already has, and leaves the legacy files in place (optionally alongside a `.bak`). Install scripts never delete account files. Kiro has no v1 file to migrate. Legacy plugin array entries are rewritten when you run `bun scripts/install.ts --with-plugin-entry`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Provider missing in OpenCode | Plugin path is absolute and points at the package root; restart OpenCode |
| `op-ai: command not found` | Re-run with `--path`, then open a new terminal or `source ~/.zshrc` |
| Sidebar shows no Accounts section | `bun scripts/install-tui.ts` registers it in `tui.json`, separately from `opencode.json` |
| Requests fail immediately with an exhausted message | `op-ai limits --probe` for real usage; `op-ai health` to revalidate tokens |
| Kiro requests hit the wrong region | EU API keys usually need `--region eu-central-1`; check `MULTI_AI_KIRO_DEFAULT_REGION` |
| An account keeps getting skipped | `op-ai list` shows disabled / flagged / blocked state; `op-ai enable --id …` restores it |

## Develop

```bash
bun install
npm run typecheck            # tsc --noEmit
npm test                     # vitest run
npm run test:tui-ffi         # TUI test under Bun
bun scripts/cli.ts help
bun scripts/install.ts --config /tmp/opencode.json
```

Tests live flat in `test/*.test.ts`. Architecture notes are split hierarchically: `AGENTS.md` at the root, plus `lib/core/`, `lib/providers/*/`, `lib/plugin/`, and `lib/tui/`.

The spine is `storage → accounts → (rotation-fetch | Kiro custom transport) ← provider adapters`. Each provider implements `TransportProviderAdapter` in `lib/providers/<name>/adapter.ts` and stays isolated from the others.

## License

MIT — see [LICENSE](LICENSE).
