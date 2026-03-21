# Sidekick Technical Implementation Guide

This document explains the technical implementation of Sidekick with a focus on the package stack: which packages are in use, what responsibility each one has, and how they fit into the plugin architecture.

## 1. High-level architecture

At runtime, Sidekick is an Obsidian plugin with a thin host layer and a thicker application layer:

1. `src/main.ts` boots the plugin, loads settings, registers the sidebar view, editor integrations, and initializes the Copilot client bridge.
2. `src/sidekickView.ts` is the main application controller for the sidebar UI. It coordinates chat state, model selection, agents, skills, tools, triggers, and sessions.
3. `src/configLoader.ts` reads the user-defined markdown and JSON configuration from the vault: agents, skills, prompts, triggers, and MCP server definitions.
4. `src/view/sessionConfig.ts` maps Obsidian context into SDK-ready attachments, prompts, working directory, and MCP server configuration.
5. `src/copilot.ts` wraps `@github/copilot-sdk` and is the boundary between the Obsidian plugin and Copilot CLI / provider-backed model execution.

In practical terms, the flow is:

`Obsidian UI -> SidekickView -> SessionConfig/ConfigLoader -> CopilotService -> @github/copilot-sdk -> Copilot CLI or provider endpoint`

## 2. Runtime dependencies

The runtime dependency set is intentionally small.

### `obsidian`

This is the host API for the plugin. Almost every user-facing behavior depends on it.

What it is used for:

- Plugin lifecycle via `Plugin` in `src/main.ts`.
- Rendering views, modals, menus, settings, notices, and markdown UI across `src/sidekickView.ts`, `src/settings.ts`, and `src/modals/*`.
- Vault access and file abstractions such as `TFile`, `TFolder`, and `normalizePath` in `src/configLoader.ts`, `src/view/sessionConfig.ts`, and the editor/search features.
- Secure-ish vault-local storage for secrets through `app.loadLocalStorage` and `app.saveLocalStorage` in `src/settings.ts`.
- HTTP requests for the Telegram integration through `requestUrl` in `src/bots/telegramApi.ts`.

Why it matters:

`obsidian` is the plugin host platform. Without it, the rest of the code has nowhere to render UI, no vault to read from, and no plugin lifecycle.

### `@github/copilot-sdk`

This is the core AI integration library. Sidekick does not speak to Copilot CLI directly in most places; it goes through this SDK wrapper in `src/copilot.ts`.

What it is used for:

- Creating and managing a `CopilotClient`.
- Starting local CLI-backed sessions or connecting to a remote CLI server.
- Creating, resuming, listing, and deleting sessions.
- Sending prompts and receiving streamed assistant responses.
- Managing model metadata, permissions, MCP server configuration, and user-input callbacks.
- Supporting both GitHub-backed and BYOK provider flows through SDK provider configuration types.

Important implementation detail:

`src/copilot.ts` is not just a thin export file. It adds Sidekick-specific behavior on top of the SDK:

- Resolves the local Copilot CLI executable automatically.
- Builds a sanitized environment before spawning the CLI.
- Handles reconnect and broken-client recovery.
- Exposes a higher-level `CopilotService` API that the rest of the plugin uses.

Why it matters:

This package is the actual conversation engine. Sidekick's chat UI, search mode, triggers, inline edits, and Telegram bot all depend on it.

## 3. Peer dependencies

These packages are required by features in the editor, but they are not bundled into the plugin because Obsidian already provides the editor runtime.

### `@codemirror/state`

Used in `src/editor/ghostText.ts` to define editor state fields, effects, and transactions for inline suggestion behavior.

What it does here:

- Tracks ghost-text suggestion state.
- Updates editor extension state as suggestions are requested, shown, accepted, or cleared.

### `@codemirror/view`

Used in `src/editor/ghostText.ts` and typed in `src/editor/editorMenu.ts`.

What it does here:

- Implements the editor view plugin layer.
- Renders ghost-text decorations in the editor.
- Connects Sidekick actions to the active CodeMirror editor instance.

Why these are peer dependencies instead of normal dependencies:

Obsidian already ships the editor environment. The build marks CodeMirror packages as external so the plugin reuses the host-provided versions instead of bundling its own copies.

## 4. Build and tooling dependencies

These packages are primarily for development, bundling, linting, and type-checking.

### `esbuild`

Configured in `esbuild.config.mjs`.

What it does:

- Bundles `src/main.ts` and the rest of the TypeScript source into a single `main.js` plugin file.
- Leaves `obsidian`, CodeMirror packages, Electron, and Node built-ins as externals.
- Produces a faster dev loop with watch mode.
- Minifies production builds.

Why it matters:

Obsidian loads a bundled plugin entrypoint. `esbuild` is the packaging step that turns the modular source tree into that deployable output.

### `typescript`

Used by the `build` script via `tsc -noEmit`.

What it does:

- Type-checks the codebase in strict mode.
- Validates interfaces between the Obsidian layer, the Copilot SDK layer, and the config-driven features.

Why it matters:

The plugin is heavily configuration-driven and event-driven. TypeScript is doing real safety work here, not just editor niceties.

### `tsx`

This package is present as a dev dependency for TypeScript execution in Node-based tooling workflows.

In this repository:

- It is not part of the shipped plugin runtime.
- It is useful for running TS-based tooling or scripts without a separate compile step.

### `jiti`

This is another tool-oriented dependency used in ecosystems that need to load TypeScript or ESM modules dynamically.

In this repository:

- It is not referenced by application code under `src/`.
- It supports the tooling/config environment rather than the Obsidian runtime.

### `tslib`

Provides helper functions that TypeScript can emit for compiled output depending on compiler settings and the build chain.

In this repository:

- It is a support dependency for the TS toolchain.
- It is not a primary architectural dependency of the plugin logic itself.

## 5. Linting dependencies

### `eslint`

The package is used through the `lint` script in `package.json`.

What it does:

- Runs static analysis across the repository.
- Catches style and correctness issues that are not fully covered by TypeScript.

### `@eslint/js`

Provides the base ESLint rule sets for JavaScript projects.

### `typescript-eslint`

Adds TypeScript-aware linting.

What it does here:

- Parses TypeScript files.
- Enables TypeScript-specific rules and diagnostics.

### `eslint-plugin-obsidianmd`

An Obsidian-focused linting plugin.

What it does here:

- Helps align the codebase with Obsidian plugin conventions and patterns.

### `globals`

Provides curated global variable definitions for lint configuration.

### `@types/node`

Adds TypeScript typings for Node.js APIs used in build scripts and runtime bridge code.

Why it matters:

Sidekick uses Node built-ins in places such as `src/copilot.ts` and `esbuild.config.mjs`, especially for process spawning, filesystem checks, OS paths, and runtime environment access.

## 6. Why the dependency list is small

A notable design choice in this repository is that most of the application logic is handwritten instead of delegated to many framework libraries.

Examples:

- The sidebar UI is built directly with Obsidian DOM helpers instead of React or another UI framework.
- Markdown-based config loading is implemented inside the repo rather than outsourced to a larger configuration framework.
- The Copilot integration is isolated behind one main external runtime package: `@github/copilot-sdk`.

This keeps the plugin easier to ship inside Obsidian, where bundle size, compatibility, and low operational complexity matter.

## 7. Internal modules and how they relate to packages

The package list makes more sense when mapped onto the internal module boundaries.

### Bootstrapping and host integration

- `src/main.ts`
- Primary package: `obsidian`

Responsibilities:

- Load and save plugin settings.
- Register the view, commands, ribbon icon, editor extensions, and context menus.
- Initialize the AI bridge service.

### AI transport and provider bridge

- `src/copilot.ts`
- Primary packages: `@github/copilot-sdk`, Node built-ins

Responsibilities:

- Start or connect to the Copilot backend.
- Manage session lifecycle.
- Wrap permissions, models, authentication, and message exchange.
- Isolate CLI spawning details from the UI layer.

### Main application controller

- `src/sidekickView.ts`
- Primary packages: `obsidian`, local application modules, Copilot types

Responsibilities:

- Maintain current chat session state.
- Keep selected agent/model/skills/tools in sync with the UI.
- Orchestrate chat, search, trigger execution, and session persistence.

### Config-driven capabilities

- `src/configLoader.ts`
- Primary package: `obsidian`

Responsibilities:

- Read `.agent.md`, `.prompt.md`, `.trigger.md`, skills, and MCP config files from the vault.
- Parse frontmatter-like metadata and convert it into typed runtime config.

### Session preparation

- `src/view/sessionConfig.ts`
- Primary package: `obsidian`

Responsibilities:

- Turn active note, selected files, vault scopes, and attachments into SDK-ready inputs.
- Map MCP server definitions into the structures expected by the Copilot SDK.

### Editor augmentation

- `src/editor/ghostText.ts`
- `src/editor/editorMenu.ts`
- Primary packages: `@codemirror/state`, `@codemirror/view`, `obsidian`

Responsibilities:

- Add inline ghost-text completions.
- Add Sidekick actions to editor and file context menus.
- Trigger focused rewrite / transform actions against selected text.

### Automation and bots

- `src/triggerScheduler.ts`
- `src/bots/telegramBot.ts`
- `src/bots/telegramApi.ts`
- Primary packages: `@github/copilot-sdk` via the local wrapper, `obsidian`

Responsibilities:

- Trigger background AI actions based on cron or file-glob events.
- Expose Sidekick conversations through Telegram.
- Reuse the same agent/tool/session model outside the main sidebar UI.

## 8. External systems Sidekick depends on beyond npm packages

Some of the most important moving parts are not npm packages in `package.json`, but runtime systems the plugin expects to exist.

### Copilot CLI

Sidekick can launch a local Copilot CLI binary or connect to a remote CLI server. The SDK is the library layer; the CLI is the execution backend.

### MCP servers

These are configured by the user in `sidekick/tools/mcp.json` and then mapped into SDK configuration. They extend the assistant with tools such as GitHub access or local commands.

### Vault-defined agents, skills, prompts, and triggers

These are not code dependencies, but they are first-class runtime inputs. Much of Sidekick's behavior is intentionally data-driven from files inside the vault.

## 9. Practical summary

If you need the shortest accurate explanation of the package stack, it is this:

- `obsidian` gives Sidekick its host environment, UI primitives, vault access, and plugin lifecycle.
- `@github/copilot-sdk` gives Sidekick its AI conversation, model, session, permission, and MCP integration layer.
- `@codemirror/state` and `@codemirror/view` power the editor-specific ghost-text and inline editing features.
- `esbuild`, `typescript`, and the ESLint packages are the development toolchain that builds and validates the plugin.

Everything else in the repository is application code that composes those building blocks into a configurable AI assistant for Obsidian.