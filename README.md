# omp-pulse

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink)](https://github.com/sponsors/joshuaswarren)

One line of transcript status in the [omp](https://github.com/can1357/oh-my-pi) TUI, refreshed on a timer while a turn is running.

The strip reads the session branch omp already keeps. It derives a local progress line and, when a refresh is eligible, asks omp's **smol** model role (`modelRoles.smol`) to rewrite the progress as one line. By default it uses `setWidget` (`belowEditor`); if that call throws, it falls back to `setStatus`. It does not send a prompt, steer, follow-up, or aside into the live turn. The separate summary call can still send transcript excerpts to a model provider.

```
+--------------------------------------------------------------+
|  editor                                                      |
+--------------------------------------------------------------+
| pulse · editing the status strip                             |  widget, belowEditor (default)
| git · model · ctx                                            |  native statusline
+--------------------------------------------------------------+
```

`belowEditor` is an omp widget placement, not a slot below the native statusline. The layout depends on the host version. Upstream discussions track the lower slot ([oh-my-pi #11100](https://github.com/can1357/oh-my-pi/issues/11100)) and header/footer support ([oh-my-pi #13473](https://github.com/can1357/oh-my-pi/issues/13473)); this extension calls neither `setFooter` nor `setHeader`.

`surface: "both"` sends the same `pulse · …` line to `setWidget` and `setStatus`, so hosts supporting both slots can show it twice. The default is `widget`, leaving the native statusline for git, model, and context when the widget is available.

On turn start, the extension tries to show a local extract of progress since the latest nonempty user message or user-attributed custom message. It combines assistant prose with tool names, shortened targets and success/error flags. Model output is checked for vague status, incomplete phrases, answers, topic paraphrases and repetition of only the latest action or clause. These are heuristics, not a factual completion check or a security filter. If no usable line is available during a turn, the existing strip is left unchanged.

The in-flight token stream is not on the branch until omp records the message. The strip reads recorded branch entries, not a second token queue. It omits direct user-message text from the model payload, but assistant prose and tool output can repeat that text or contain sensitive data.

Start with [installation](#install), then see [configuration](#config), [status meanings](#what-the-status-means) or [troubleshooting](#troubleshooting).

## Install

```sh
omp plugin install omp-pulse
```

From a checkout:

```sh
omp plugin link /path/to/omp-pulse
```

`package.json` declares Node 20 or newer. The host must load TypeScript extensions and provide the session/UI/model APIs used here. Managed timers (`ctx.setInterval` with `ctx.clearTimer`) are preferred; if `setInterval` is absent, the extension uses an unref'ed native timer. The release workflow uses Node 24; its test command relies on `--experimental-strip-types`, which is not available on Node 20. The engine declaration alone does not establish compatibility with every Node/omp combination.

### First use

1. Run `omp plugin list` in your shell and check that `omp-pulse` is installed and enabled.
2. Start a new omp TUI process. Let the agent record some assistant or tool progress.
3. Enter `/pulse` in omp. Its notice names the loaded package version and the current line.

The notice confirms that the command handler loaded. It does not prove that a model request succeeded. Before recorded progress exists, the strip can show `idle` or remain unchanged.

## Config

Optional file at `~/.omp/agent/omp-pulse/config.json`. Configuration is loaded once when the extension is initialized; there is no config-reload command or file watcher. Recognized environment values take precedence over the file. Blank strings and invalid numeric/boolean environment values fall back to the file/default; malformed or unreadable JSON silently uses defaults.

With no endpoint override, the extension resolves omp's **smol** role (`ctx.models.resolve("@smol")`) and calls `@oh-my-pi/pi-ai`'s `completeSimple`. Credentials come from `ctx.modelRegistry.getApiKey`, with the registry resolver used when available. Missing model/credentials, request failure or unusable output falls back to local extraction; without usable local progress, an in-turn refresh can leave the previous line visible.

Start with the defaults; create the JSON file only when you need different settings. After editing it, fully exit and restart the omp process. Switching sessions or running `/pulse` does not reload this file.

For a new TUI process with the version visible and the native status surface selected:

```sh
OMP_PULSE_SHOW_VERSION=1 OMP_PULSE_SURFACE=status omp
```

Those environment values override the file for that process. The example changes the display, not which provider receives summary requests.

Example `config.json`:
```json
{
  "intervalMs": 420000,
  "refreshWhileIdle": false,
  "surface": "widget",
  "placement": "belowEditor",
  "maxTranscriptChars": 8000,
  "provider": {
    "timeoutMs": 15000
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `intervalMs` | `420000` (7 min) | Timer refresh interval. Clamped to 60000–1800000 ms (1–30 min); `0` does not disable the timer. Eligible turn-end and manual refreshes are additional to it. |
| `refreshWhileIdle` | `false` | Permit timer refreshes while idle if the normalized transcript changed. This does not disable turn-end or manual refreshes. |
| `surface` | `widget` | `widget`, `status`, or `both`. Widget-only falls back to status if `setWidget` throws; a silent no-op is not detected. |
| `placement` | `belowEditor` | `aboveEditor` or `belowEditor`. |
| `maxTranscriptChars` | `8000` | Tail of the normalized current-turn progress text sent to the model, clamped to 500–32000 JavaScript string units. Not a token budget, raw branch limit or secret-redaction control. |
| `provider.baseUrl` | empty | Empty uses omp smol. A nonempty override suppresses that route; only a valid http(s) URL plus a model sends an override request. An invalid/incomplete override falls back locally, not to smol. |
| `provider.model` | empty | Model name for the opt-in endpoint. Ignored when `baseUrl` is empty. |
| `provider.apiKey` | empty | Sent as `Authorization: Bearer` to the override endpoint when set. Smol instead uses omp's model registry credential. |
| `provider.timeoutMs` | `15000` | Per-completion/fetch abort timeout, clamped to 1000–60000 ms. A tick can make a second completion; model/credential resolution is outside this timeout. |

Environment overrides:

| Variable | Overrides |
| --- | --- |
| `OMP_PULSE_INTERVAL_MS` | `intervalMs` |
| `OMP_PULSE_IDLE` | `refreshWhileIdle` (`true`/`1` or `false`/`0`) |
| `OMP_PULSE_SURFACE` | `surface` |
| `OMP_PULSE_PLACEMENT` | `placement` |
| `OMP_PULSE_MAX_CHARS` | `maxTranscriptChars` |
| `OMP_PULSE_BASE_URL` | `provider.baseUrl` |
| `OMP_PULSE_MODEL` | `provider.model` |
| `OMP_PULSE_API_KEY` | `provider.apiKey` |
| `OMP_PULSE_TIMEOUT_MS` | `provider.timeoutMs` |
| `OMP_PULSE_SHOW_VERSION` | Environment-only: `1` or `true` adds the package version to the strip. The value is read from `package.json` (fallback `0.0.0`); the preferred body budget shrinks to keep the row at 60 JavaScript string units. This is not terminal-cell width measurement. |

`/pulse` always includes that version in its notice (`omp-pulse <version> · <line>`), even when `OMP_PULSE_SHOW_VERSION` is off.

### Smol

Configure the cheap model on omp itself, under `modelRoles.smol`, with the credentials omp stores for that provider. omp-pulse does not hard-code a model ID or a localhost endpoint. The selected smol provider may be remote or local; this plugin does not enforce local processing. `provider.apiKey` is not used on the smol path.
See [omp's role settings](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md#role-aliases-and-settings) for setup. `modelRoles.smol` belongs to omp's configuration, not this plugin's JSON file.

A config copied from 0.1.3 that still sets `provider.baseUrl` and `provider.model` opts out of smol. Remove those two keys to use smol again.

### Opt-in OpenAI-compatible endpoint

Override requests are made only with a valid `http:` or `https:` base URL and a nonempty model. A nonempty but invalid/incomplete override does not fall through to smol. The override credential is separate from the registry lookup used on the default path.

```sh
export OMP_PULSE_BASE_URL=https://api.openai.com/v1
export OMP_PULSE_MODEL=gpt-4.1-nano
export OMP_PULSE_API_KEY='<provider-issued-key>'
```

Use an OpenAI-compatible base URL such as `https://api.openai.com/v1`. The plugin appends `/chat/completions` unless the path already ends with it; it does not insert `/v1`. URL fragments are removed, but query parameters are retained. Prefer HTTPS, avoid credentials in URLs, and treat the configured endpoint as a recipient of both the transcript payload and any override bearer key.

## Refresh behavior

- The first session start arms the timer and attempts local extraction. Session switch, session branch and turn start also attempt local extraction without an immediate model call.
- Timer ticks request a model refresh only when progress text is nonempty, permitted by the idle setting, and different from the last accepted model-backed transcript.
- Turn end requests a refresh before changing the phase to idle. `/pulse` forces a refresh, bypassing the idle/unchanged checks, but still skips an empty transcript.
- One refresh loop runs at a time; overlapping requests coalesce into a pending refresh. This is not one model request per interval: rejected model output can cause one retry when no concrete local extract exists.
- A local fallback does not mark the transcript as successfully summarized. A later tick can retry unchanged text after a failed or rejected model response.
- Each completion requests at most 60 output tokens; the preferred painted line is 60 JavaScript string units including `pulse · ` and the optional version. Word trimming and an 80-unit hard fallback are display controls, not Unicode terminal-width or escape-sequence sanitization.

## What the status means

The body is free-form text, not a fixed set of machine states. A local extract or model rewrite can produce it; the strip does not label which route supplied the line.

| Example body after `pulse · ` | Meaning |
| --- | --- |
| `idle` | No usable progress line was selected during initialization or an idle fallback. It is not a reliable indication that the agent stopped. |
| `Reading …`, `Searching …`, `Editing …` | The transcript contains corresponding tool calls or assistant prose. A call can appear before its result; the line does not prove completion. |
| `Running …` | A recorded action names a command or another tool target. This is not a live process monitor. |
| `Read the code`, `Reviewed the code`, `Updated the code`, `Ran checks` | The local extract combines recorded action categories. Confirm results in the main transcript, especially for checks and tests. |
| `Blocked on …` | The latest concrete action in the local extract has an error flag. Inspect its actual result; the label does not establish that the whole task is blocked. |
| Another short progress sentence | An assistant-derived line or model rewrite summarizes the work. It can be incomplete, stale or wrong. |

With `OMP_PULSE_SHOW_VERSION=1`, the format is `pulse · <version> · <body>`. The version is package metadata, not a health check. It takes space from the body budget.

A missing strip or unchanged line does not prove that work stopped or a provider failed. The [refresh rules](#refresh-behavior) and [known issues](#troubleshooting) explain those cases.

## Does not join the live turn

omp-pulse never calls `prompt`, `steer`, `followUp`, aside delivery, or `sendUserMessage`. A refresh reads `ctx.sessionManager.getBranch()`, may make a separate summary-model call, and paints the result through the UI. It does not execute commands found in the transcript or give the summary model tool definitions.

`/pulse` forces that refresh and posts an informational notice with the package version and current line. It does not enqueue an agent turn, toggle the extension, or reload configuration.

Typing `Status?` into the omp prompt is a different path. That text joins the live turn. This strip exists so you do not have to do that.

## Privacy and trust

The model receives selected assistant text, tool names, shortened paths/commands or queries, tool-result excerpts and some error text from the current branch after its latest user boundary. This can include repository content, personal data or credentials repeated by tools. Local extraction can expose shortened targets or assistant text in the strip too. Neither path scans for secrets.

The extension reads its own config and package version, and creates the config parent directory on session start if possible. It does not write a summary log or transcript file itself. omp, providers, terminals and screen recordings may retain data independently.

Treat the strip as untrusted, advisory text, not evidence that tests passed or an action completed. The plugin does not read terminal/window titles directly, but titles or status text captured in tool results can influence the model. Whitespace/markdown cleanup is not terminal-control sanitization, and a local fallback is not a privacy boundary.

See the [threat model](https://github.com/joshuaswarren/omp-pulse/blob/main/docs/THREAT_MODEL.md) for trust boundaries, residual risks and operator precautions. It lives in the repository; the current npm `files` list does not include `docs/`.

## Troubleshooting

The workarounds below apply to the source-reviewed 0.1.7 behavior. They do not fix the six linked bugs or establish that a later release includes a fix. Check each issue's current state.

### No strip, duplicate lines or ignored settings

1. Check `omp plugin list`. If the installed package is disabled, use `omp plugin enable omp-pulse`, then restart the omp process.
2. Run `/pulse` after the agent records progress. A fresh session with no usable progress may not produce a summary.
3. If the widget is missing, try the `OMP_PULSE_SURFACE=status` launch setting above. A host can silently ignore widgets without triggering the fallback.
4. If the line appears twice, select `widget` or `status` instead of `both`.
5. If a config edit has no effect, restart the process and check inherited `OMP_PULSE_*` variables. Invalid JSON silently restores defaults.

For a local-looking line that never gets rewritten, check the provider route. A nonempty `provider.baseUrl` suppresses smol even when the URL or model is invalid. To return to smol, remove the override from both the JSON file and the inherited environment. A blank environment value does not erase a file value. Check omp's smol assignment and credentials separately; failures can fall back without a warning in the strip.

### Temporarily disable omp-pulse

Run these commands in your shell, then restart every affected omp process:

```sh
omp plugin disable omp-pulse
omp plugin list
```

Confirm the package is disabled in the affected project. Disabling an installed package does not unload an instance already running. Remove any explicit Pulse startup path too; `-e`/`--extension` or `--hook` can load code independently of the installed package.

For one new process, the host also supports:

```sh
omp --no-extensions
```

This skips all ambient extension discovery, not just omp-pulse. Explicit `-e`/`--extension` and `--hook` paths still load, so omit any Pulse path. It does not disable every other discovery subsystem or create a sandbox. See [omp's extension controls](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md#enabledisable-controls).

When you choose to restore the installed plugin, use `omp plugin enable omp-pulse` and start a new process.

### Terminal text changes appearance or terminal state

Tracked in [#11](https://github.com/joshuaswarren/omp-pulse/issues/11). Filenames, transcript text or model replies can carry terminal controls into the strip.

Disable the plugin and restart before reviewing untrusted content that can contain those controls. Changing `surface`, shortening the transcript or relying on local extraction does not sanitize text. Do not paste a raw control-sequence payload into a live terminal to investigate. The [threat model](https://github.com/joshuaswarren/omp-pulse/blob/main/docs/THREAT_MODEL.md#2-terminal-title-and-display-control-injection) explains this boundary.

### Refreshes stop while the agent still works

Tracked in [#12](https://github.com/joshuaswarren/omp-pulse/issues/12). An older summary can finish after another turn starts and incorrectly mark the shared phase idle.

Use `/pulse` for a manual refresh when the transcript contains progress. For automatic refreshes despite that phase error, start a new process with:

```sh
OMP_PULSE_IDLE=1 omp
```

This permits changed-transcript refreshes during real idle periods too, so it can increase provider requests. It bypasses the idle gate; it does not fix the race.

### A previous session's status appears, or the strip returns after shutdown

Tracked in [#13](https://github.com/joshuaswarren/omp-pulse/issues/13). Clearing the timer or switching history does not cancel a pending summary.

For a stale line, let any pending refresh settle, then run `/pulse` against the intended branch. Empty or unusable progress can still leave the previous line visible. There is no plugin command that guarantees cancellation of an in-flight request. When separation matters, disable Pulse and restart omp on the intended session instead of relying on a live switch.

### Headless runs make summary requests without a visible strip

Tracked in [#14](https://github.com/joshuaswarren/omp-pulse/issues/14). The extension does not skip its requests when the host has no usable display.

Disable the installed plugin before starting those jobs, or use `--no-extensions` on the new invocation:

```sh
omp --no-extensions -p 'your prompt'
```

As above, this also excludes other ambient extensions; explicit extension paths still load. Display settings and `refreshWhileIdle: false` do not disable turn-end requests. `intervalMs: 0` clamps to one minute rather than turning the timer off.

### Text cuts off in a narrow pane

Tracked in [#15](https://github.com/joshuaswarren/omp-pulse/issues/15). The widget uses a fixed character budget and ignores the render width supplied by the host.

Widen the pane until the full line is visible. The preferred row budget is 60 JavaScript string units, but wide glyphs can require more than 60 terminal columns. There is no configurable row-width limit. `maxTranscriptChars` changes model input size, not the displayed width.

### `/tree` leaves the previous branch's line visible

Tracked in [#16](https://github.com/joshuaswarren/omp-pulse/issues/16). Pulse has no handler for tree navigation, and the default idle setting prevents a timer correction.

Run `/pulse` after navigation when the selected branch contains recorded progress. If that branch has no usable progress, restart omp on the intended session to clear the previous strip. If an older summary remains pending, apply the [session-switch workaround](#a-previous-sessions-status-appears-or-the-strip-returns-after-shutdown) too. A manual refresh does not fix the missing event handler.

### Report a problem

Include the version from `/pulse`, the rendering surface, the terminal and pane width, and the event order. State whether the route uses smol or an override, without including keys. Use synthetic progress text or escaped examples instead of private transcripts and raw terminal controls. Link the matching issue above when the symptom is already known.

## Develop

```sh
npm install
npm test
npm run typecheck
```

These commands exercise the unit tests and TypeScript checks; they do not validate live omp layout, provider behavior, prompt-injection resistance or terminal escape handling. Use Node 24 to match the release workflow's runtime.

## Publish

The package name on npm is `omp-pulse`. The release workflow requests `id-token: write` for npm Trusted Publishing (OIDC) and does not reference an npm bearer-token secret. Successful publishing still depends on npm's external Trusted Publisher settings; those settings are not defined or verified by this repository.

1. Bump `version` in `package.json` (semver).
2. Merge the version bump through the project's normal reviewed change process. Use a release commit such as `chore: release vX.Y.Z`.
3. Tag and push the intended release commit. The tag must match the `package.json` version, with a leading `v`:

```sh
git tag vX.Y.Z && git push origin vX.Y.Z
```

4. `.github/workflows/publish.yml` checks out the tag on a GitHub-hosted runner, selects Node 24, upgrades to `npm@latest`, runs `npm install`, `npm test` and `npm run typecheck`, verifies the tag matches the package version, then runs `npm publish --access public`. It relies on OIDC authentication. Check the published npm artifact's provenance rather than treating a workflow declaration as proof that a particular release has it.
5. Install the published package:

```sh
omp plugin install omp-pulse
```

An unversioned install does not pin an exact release; `omp plugin install omp-pulse@X.Y.Z` requests one. Package metadata points omp at `./src/index.ts`. Update/reinstall behavior is owned by the installed omp version, not implemented by this plugin.

6. Before publishing, an operator configures a Trusted Publisher on npmjs.com for:

   - Provider: GitHub Actions
   - Repository: `joshuaswarren/omp-pulse`
   - Workflow filename: `publish.yml`
   - A publishing action compatible with this workflow's direct `npm publish`

Pushing a `v*` tag or publishing a GitHub Release starts this workflow; it has no pull-request trigger. npm rejects an already-published version, so triggering both for the same version can produce a duplicate-publish failure. npm's publisher UI, allowed actions and authentication behavior can change independently of this code; verify them against current npm documentation rather than relying on a dated default.

The `pi.extensions` field points at `./src/index.ts`, which is the layout omp loads for `omp plugin install`.

## Support

Every bit of support helps keep omp-pulse alive and free. If you are able, [sponsor on GitHub](https://github.com/sponsors/joshuaswarren) or send a Lightning donation to `joshuaswarren@strike.me` to directly fund continued development and new integrations.

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?style=for-the-badge)](https://github.com/sponsors/joshuaswarren)

If financial support is not an option, you can still make a big difference: [star the repo](https://github.com/joshuaswarren/omp-pulse), share it, or recommend it to a colleague. Word of mouth is how most people find omp-pulse.
