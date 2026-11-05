# Threat model

## Scope and assumptions

This document describes the implementation at version 0.1.7, source commit [`d692418e961fc8046412aedbe5fec6748a678413`](https://github.com/joshuaswarren/omp-pulse/tree/d692418e961fc8046412aedbe5fec6748a678413). It is a source review, not a penetration test, a certification, or a claim that the listed attacks have been reproduced. Update it when transcript selection, provider routing, output rendering, configuration or release behavior changes.

omp-pulse runs inside the omp process. It is not a sandbox: the host, loaded extension code, runtime dependencies and anyone able to replace those components are trusted with that process's privileges. A compromised host or installed package can do more than this plugin's normal code paths. An attacker who controls only repository text, tool output or a summarizer response has a narrower opportunity: influencing what is sent to the summary model and what the user sees.

The strip is advisory text. It is not an authorization prompt, command interface, audit log, test result, or proof that an action completed. Being separate from the live agent turn reduces one route for influencing the agent, but does not make the summary trustworthy or the data flow local-only.

## Assets and entry points

Protect:

- Confidential session data: assistant text, repository content, paths, commands, queries, tool results, errors and personal information.
- Provider credentials and endpoint settings.
- Integrity of the visible status line and the user's interpretation of progress.
- Session separation, responsiveness, and model-request cost.
- Integrity of the installed npm package, host-provided model client and publishing chain.

Potential lower-trust inputs include repository files, command output, dependency/build logs, tool-returned status text, assistant prose influenced by those inputs, and the summary model's reply. Local configuration and environment variables control network routing and credentials, so their writers belong to the trusted computing base. A party able to change config or the process environment is not merely supplying summary content.

## Data read, transformed and displayed

| Source | What the plugin reads and does | Exposure boundary |
| --- | --- | --- |
| `ctx.sessionManager.getBranch()` | Reads the active branch entries supplied by omp. Recognizes user, assistant and tool/tool-result messages, plus selected attributed custom messages. User-attributed custom messages and `skill-prompt` entries can set the current-turn boundary. | Session data enters plugin memory. This is not an independent disk transcript reader. |
| User text | Uses nonempty user text to locate the latest boundary and detect paraphrases. Direct user messages are not serialized as model-payload lines. | Omission is not de-identification: later assistant/tool text can repeat the request, secrets or identifiers. |
| Assistant messages | Selects text blocks and tool-call names/targets. Some assistant errors without prose/calls are represented as failed model-tool entries. Thinking/non-text blocks are not selected by these readers. | Selected prose and errors can enter the provider payload and local status. |
| Tool calls/results | Selects tool names, path/command/query targets, success/error flags and text excerpts. Paths are usually shortened to their last two components; commands to their first four whitespace-delimited tokens; query/pattern targets to a short line. | Shortening can retain secret values or identifying filenames. Tool-result excerpts remain content, not trustworthy instructions. |
| Config file | Reads `~/.omp/agent/omp-pulse/config.json` once at extension initialization. A bad or unreadable file silently behaves like an empty config. | The file can select an endpoint and hold a plaintext API key. No file-permission check, encryption or secret-store write is implemented. |
| Environment | Reads the documented `OMP_PULSE_*` settings from the inherited environment. It does not enumerate arbitrary environment values into a summary. | These variables can redirect disclosure or provide a credential. Blank string overrides fall back to file/default rather than erasing a configured value. |
| omp model registry | Resolves `@smol`, calls `modelRegistry.getApiKey`, and uses the registry credential resolver when available. | The host owns provider selection and credential storage. The selected provider need not be local. |
| Package metadata | Reads the adjacent `package.json` version; falls back to `0.0.0`. | Version text can appear in `/pulse` notices and optionally in the strip. Package metadata is part of the trusted installation. |
| Summary reply | Reads textual completion content, performs formatting and status-quality checks, then paints a line. | Model-controlled text reaches terminal/UI rendering. It is not a trusted assessment of work. |

`progressOf` retains work after the latest recognized nonempty user boundary. `recentTranscript` builds normalized `assistant:` and `tool:` lines, limits individual lines to 500 JavaScript string units, limits tool-detail excerpts to 180, then retains the last configured `maxTranscriptChars` units (default 8,000; clamp 500–32,000). Truncation is not semantic redaction and can cut across records or control sequences. Local extraction uses the current-turn items independently of that outbound tail cap.

The in-memory field called `fingerprint` is the selected transcript string itself, not a cryptographic hash. Accepted model output advances it; a local fallback leaves the previous accepted value. The plugin also retains the last painted line. It has no encrypted-memory boundary or memory-dump protection.

The plugin creates the config's parent directory if possible. Its own code does not write a transcript archive, summary file, telemetry log or credential file. That statement does not cover omp's persistence, model-provider retention, terminal scrollback, screenshots, process inspection or external logging.

## Provider trust boundaries

### Default smol route

With an empty `provider.baseUrl`, `summarizeWithSmol` resolves `@smol` through omp and sends the selected transcript as a user message alongside a summary system prompt using the host-provided `@oh-my-pi/pi-ai` client. The call requests `maxTokens: 60`, disabled reasoning and an abort signal. The plugin does not pass tool definitions or a live-turn delivery API to this completion.

The selected smol provider receives the transcript according to the host client's routing and credential behavior. The plugin neither enforces local inference nor defines the provider's logging, training, geographic processing or retention policies. A local-looking host configuration is not evidence of end-to-end local processing.

### Explicit endpoint route

A nonempty override suppresses smol. With a valid `http:`/`https:` URL and nonempty model, the plugin POSTs the system prompt and transcript to the configured path, appending `/chat/completions` when necessary. It sends the override key in an `Authorization: Bearer` header when present. URL fragments are removed; query parameters remain. An invalid/incomplete override falls back locally, not to smol.

The URL validator is a syntax/protocol check, not a destination policy. There is no host allowlist, HTTPS-only requirement, private-address restriction, endpoint-ownership check or plugin-level redirect policy. HTTP can expose payloads and credentials in transit. The plugin does not set `redirect: "error"`; fetch/runtime behavior, rather than a plugin security policy, determines redirect handling. Do not assume that every redirect preserves or strips every sensitive field. Review and trust the full endpoint path, query and redirect chain. The plugin does not discover a destination from transcript text; changing destinations requires control of config/environment or trusted code.

Use HTTPS and an endpoint authorized to receive this data. Do not put credentials in base-URL userinfo or query parameters. A custom endpoint is not a way to safely disclose sensitive transcripts to an otherwise untrusted service.

A missing, unreadable or malformed config file can restore the default smol route when no valid environment override supplies a different route. Do not rely on a broken config file or a blank environment variable to prevent network disclosure.

## Threats, existing measures and residual risks

### 1. Prompt injection through transcript or status text

**Scenario:** a file, tool response or captured status line contains instructions to ignore the summary task, claim success, repeat sensitive text, or present an attacker-chosen action as the current work. Tool-result excerpts are supplied in the summary model's user-message text; the model can mistake embedded instructions for authority.

**Existing measures:** a separate system prompt asks for a short progress-only clause. The transcript reader excludes direct user messages, non-text blocks and many request paraphrases. `runTick` rejects vague, truncated, answer-like, topic-like and latest-action-only lines. The summary path does not execute transcript commands or call the live agent's prompt/steer/follow-up APIs.

**Residual risk:** instruction hierarchy and output-quality heuristics are not an injection defense or factual verifier. A plausible short status can pass them. Instructions repeated by assistant prose can also influence the local extract. The fallback is not an independently trusted source. There is no content-origin authentication or proof-of-completion check.

**Operator precaution:** treat the strip as an untrusted convenience. Verify actual tool/test results before acting on a success claim. Do not copy a status suggestion into a command or feed the strip into an automation agent as an instruction or privileged signal.

### 2. Terminal-title and display-control injection

**Direct title access:** the implementation does not query terminal/window titles, screen buffers, tmux panes or other applications' status strips. A terminal title is not an independent data source here. It becomes relevant if a tool captures it in session text or an assistant repeats it.

**Scenario:** lower-trust text includes terminal escape/control sequences, bidirectional text, misleading Unicode or a forged status label. Those bytes can enter a tool target, model output or locally extracted line and then reach `setWidget`, `setStatus` or a `/pulse` notice. Depending on the host renderer and terminal, controls could change appearance, affect a title/link, or conceal content. Clipboard-affecting controls are a terminal-dependent possibility, not a reproduced exploit in this review.

**Existing measures:** whitespace is collapsed, some markdown characters/quotes are removed from model output, and word/length limits are applied. Theme colors distinguish the `pulse` prefix from the body. The code does not intentionally emit terminal-title or clipboard-setting sequences.

**Residual risk:** these functions do not strip ANSI/OSC escape sequences, all C0/C1 controls, bidi controls or unsafe links. Length checks use JavaScript string units, not rendered terminal cells. Model and local-extract routes both require scrutiny; a short line can still carry controls. Whether a given sequence is interpreted depends on omp and terminal behavior, which was not exercised for this audit.

**Operator precaution:** use a host/terminal that safely renders untrusted text; do not assume this plugin supplies that boundary. Keep sensitive sessions out of shared displays/recordings. Do not paste raw hostile escape sequences into a live terminal when investigating a report; use escaped, synthetic representations and an isolated harness.

### 3. Secrets or private content in summaries

**Scenario:** a token is printed by a tool, placed early in a command argument, included in a path/query, echoed in an error, or repeated in assistant prose. It survives the excerpt limits, reaches the provider and may appear in the strip or notice. A malicious summarizer can echo short sensitive fragments.

**Existing measures:** request/user-message exclusion and excerpt/length limits reduce volume. The plugin does not deliberately add its configured API key to the transcript prompt; that credential is passed separately to the model client or as HTTP authorization.

**Residual risk:** no secret scanner, credential masker, PII redactor, sensitivity classification or per-source consent gate exists. Omitting user messages and shortening paths is not anonymization. A rejected reply does not undo the disclosure already made. Screen recordings and terminal viewers are separate recipients. Credential storage in JSON/environment remains plaintext from the plugin's perspective.

**Operator precaution:** do not print secrets into the host session. Use provider credentials and endpoints appropriate to the data classification, protect config/environment with host/OS controls, and use an approved provider retention policy. If summary processing is not authorized for a session, disable/unload the plugin through the host's controls before that session. There is no documented plugin-local offline-only or secret-redaction switch. Setting `refreshWhileIdle=false`, `intervalMs=0`, hiding the widget or relying on model failure is not such a switch.

### 4. Stale or cross-session progress

**Scenario:** a slow completion started on one branch/host context resolves after a session switch, branch change or shutdown, or an unusable new extract leaves an older line displayed. A viewer can attribute stale work to the wrong context, potentially exposing a prior session's short status.

**Existing measures:** switch/branch hooks reset the accepted transcript fingerprint and attempt a local extract. Refreshes run through one serialized loop with coalesced pending requests. Shutdown clears timers and UI slots.

**Residual risk:** there is no session-generation identifier attached to each asynchronous result or explicit cancellation of the in-flight completion on switch/shutdown. The loop paints through its current host reference after the awaited call. Timer cleanup is not a guarantee that an earlier call cannot finish later. Empty/unusable progress can retain the previous line. This is a source-visible race surface, not a reproduced cross-session disclosure.

**Operator precaution:** do not treat the strip as a session-isolation or audit boundary. Avoid using it for workflows that require guaranteed separation of even short status text. Verify session context and primary tool output when the line appears stale.

### 5. Availability and request cost

**Scenario:** large branch histories, many forced refreshes, repeated provider failures or hostile/slow endpoint responses consume CPU, memory, API quota or money.

**Existing measures:** the timer interval is clamped to 1–30 minutes, automatic idle refresh is off by default, unchanged accepted text is skipped, output requests are capped at 60 tokens, and each provider completion/fetch gets a 1–60 second abort timeout. One refresh loop prevents parallel tick requests within this extension instance. A rejected model line causes at most one additional completion in that tick when no concrete local extract is available.

**Residual risk:** manual `/pulse` bypasses idle/unchanged checks; turn-end calls are additional to timer refreshes. Local fallback does not advance the accepted fingerprint, so later ticks may retry the same text. The transcript size cap is applied after reading/processing the branch, not as a bound on input-history scanning. Config-file reading and HTTP JSON response parsing have no explicit byte limit; the timeout does not cover model resolution, credential lookup or module import. There is no spend ceiling, global cross-instance rate limit or circuit breaker, and timeout cancellation ultimately depends on the client/runtime honoring the signal.

### 6. Supply-chain compromise

**Installation boundary:** npm installs and linked checkouts load `src/index.ts` as an in-process extension (`pi.extensions`). A linked checkout is executable code that can change after linking. Runtime model completion dynamically imports `@oh-my-pi/pi-ai` from the host environment; it is not pinned as this package's own runtime dependency. The host package manager/runtime and that client are part of the trust boundary.

**Release boundary:** `.github/workflows/publish.yml` runs on `v*` tag pushes and published GitHub Releases. It uses GitHub-hosted runners, Node 24, `npm@latest`, `npm install`, tests and typecheck, then checks tag/package-version agreement and runs `npm publish --access public`. It requests `id-token: write` and `contents: read`, and does not reference an npm bearer-token secret.

`npm install` in the release job may also run dependency lifecycle scripts with the job's permissions. This workflow does not suppress those scripts or isolate dependency installation from the publishing job. Treat workflow and dependency changes as privileged changes, even though the shipped package declares only development dependencies of its own.

**Residual risk:** the action references are version tags (`actions/checkout@v7`, `actions/setup-node@v7`), not commit SHAs; npm is upgraded from a floating `latest`; development dependencies use semver ranges and there is no committed lockfile. The workflow does not require a publishing tag to be reachable from a protected branch. Tests/typechecks and matching a tag to a version are not code-origin, dependency-integrity or human-review guarantees. npm Trusted Publisher settings, branch/tag protection and any provenance attached to an actual release are external controls not established by this source tree. This review did not inspect installed artifacts, publisher settings or workflow runs.

**Operator/maintainer precautions:** pin an exact release when reproducibility matters, review source before linking a checkout, and verify package origin plus available npm provenance for the installed version. Restrict repository/tag/publisher administration and review workflow/dependency changes. Immutable action pins, reproducible dependency resolution and protected release provenance are possible hardening measures, **not controls claimed to be implemented here**. OIDC avoids a long-lived npm token in this workflow; it does not prevent malicious authorized code from being published.

## Code map

| Boundary | Implementation |
| --- | --- |
| Branch reads, events, timers, loop, shutdown, manual command | [`src/index.ts`](../src/index.ts): `ompPulse`, `readEntries`, `showExtract`, `runLoop`, `arm` |
| Configuration and environment precedence | [`src/config.ts`](../src/config.ts): `loadConfig`, `readConfigFile` |
| Input selection and excerpting | [`src/transcript.ts`](../src/transcript.ts): `progressOf`, `itemFrom`, `customItem`, `assistantParts`, `toolItem`, `targetFromArgs`, `recentTranscript` |
| Model routes, credentials, endpoint validation, output cleanup | [`src/summarize.ts`](../src/summarize.ts): `summarize`, `summarizeWithSmol`, `completionsUrl`, `cleanModelText` |
| Eligibility, quality rejection and bounded retry | [`src/tick.ts`](../src/tick.ts): `decideRefresh`, `runTick` |
| Formatting and UI/notice sinks | [`src/text.ts`](../src/text.ts): `oneLine`, `limitWords`, `fitStripBody`; [`src/chrome.ts`](../src/chrome.ts): `statusLine`, `paint`, `pulseNotice` |
| Version read and package/release metadata | [`src/version.ts`](../src/version.ts): `readPackageVersion`; [`package.json`](../package.json); [`publish.yml`](../.github/workflows/publish.yml) |

## Verification limits and reporting

No plugin code, test suite, build, model request, install or live terminal probe was run for this documentation audit. Host API/version compatibility, terminal interpretation of adversarial bytes, the session-switch race, timeout enforcement, provider retention, npm publisher settings and installed-package provenance remain unverified at runtime. Existing unit-test source is not proof of those properties.

Do not post real session transcripts, credentials, private paths or raw terminal control bytes in public issue reports. Describe the affected version, provider route and rendering surface with synthetic text or escaped representations. A summary containing a secret should be handled as a disclosure to the configured provider and any viewers, not merely a cosmetic rendering bug.
