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

## Install

```sh
omp plugin install omp-pulse
```

From a checkout:

```sh
omp plugin link /path/to/omp-pulse
```

`package.json` declares Node 20 or newer. The host must load TypeScript extensions and provide the session/UI/model APIs used here. Managed timers (`ctx.setInterval` with `ctx.clearTimer`) are preferred; if `setInterval` is absent, the extension uses an unref'ed native timer. The release workflow uses Node 24; its test command relies on `--experimental-strip-types`, which is not available on Node 20. The engine declaration alone does not establish compatibility with every Node/omp combination.

## Config

Optional file at `~/.omp/agent/omp-pulse/config.json`. Configuration is loaded once when the extension is initialized; there is no config-reload command or file watcher. Recognized environment values take precedence over the file. Blank strings and invalid numeric/boolean environment values fall back to the file/default; malformed or unreadable JSON silently uses defaults.

With no endpoint override, the extension resolves omp's **smol** role (`ctx.models.resolve("@smol")`) and calls `@oh-my-pi/pi-ai`'s `completeSimple`. Credentials come from `ctx.modelRegistry.getApiKey`, with the registry resolver used when available. Missing model/credentials, request failure or unusable output falls back to local extraction; without usable local progress, an in-turn refresh can leave the previous line visible.

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

## Does not join the live turn

omp-pulse never calls `prompt`, `steer`, `followUp`, aside delivery, or `sendUserMessage`. A refresh reads `ctx.sessionManager.getBranch()`, may make a separate summary-model call, and paints the result through the UI. It does not execute commands found in the transcript or give the summary model tool definitions.

`/pulse` forces that refresh and posts an informational notice with the package version and current line. It does not enqueue an agent turn, toggle the extension, or reload configuration.

Typing `Status?` into the omp prompt is a different path. That text joins the live turn. This strip exists so you do not have to do that.

## Privacy and trust

The model receives selected assistant text, tool names, shortened paths/commands or queries, tool-result excerpts and some error text from the current branch after its latest user boundary. This can include repository content, personal data or credentials repeated by tools. Local extraction can expose shortened targets or assistant text in the strip too. Neither path scans for secrets.

The extension reads its own config and package version, and creates the config parent directory on session start if possible. It does not write a summary log or transcript file itself. omp, providers, terminals and screen recordings may retain data independently.

Treat the strip as untrusted, advisory text, not evidence that tests passed or an action completed. The plugin does not read terminal/window titles directly, but titles or status text captured in tool results can influence the model. Whitespace/markdown cleanup is not terminal-control sanitization, and a local fallback is not a privacy boundary.

See the [threat model](https://github.com/joshuaswarren/omp-pulse/blob/main/docs/THREAT_MODEL.md) for trust boundaries, residual risks and operator precautions. It lives in the repository; the current npm `files` list does not include `docs/`.

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
