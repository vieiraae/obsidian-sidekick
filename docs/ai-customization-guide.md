# Obsidian Sidekick: GitHub Copilot Customization Guide

This guide explains the current GitHub Copilot customization mechanisms that matter for this repository and how they map onto the `obsidian-sidekick` plugin.

The important distinction is this:

- GitHub Copilot in VS Code and on GitHub supports several official customization file types such as `copilot-instructions.md`, `*.instructions.md`, `.prompt.md`, `.agent.md`, `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, hook files, and organization or personal instructions.
- Obsidian Sidekick does **not** automatically read those repository locations.
- Instead, Sidekick reads its own vault-local configuration folder, which defaults to `sidekick/`, and loads agents, prompts, skills, triggers, and MCP tool configuration from there.

So the practical answer is: many Copilot customization ideas are relevant to this Obsidian setup, but some are **directly supported**, some are **portable with light translation**, and some are **conceptual patterns only**.

This document covers all of those categories.

---

## 1. What Sidekick Actually Loads

Sidekick is already built around a vault-local customization model.

Its default folder layout is:

```text
sidekick/
    agents/
        *.agent.md
    prompts/
        *.prompt.md
    skills/
        <skill-name>/
            SKILL.md
            ...optional resources...
    tools/
        mcp.json
    triggers/
        *.trigger.md
```

This is derived from the plugin settings and helper functions in the codebase.

What each type does in Sidekick:

- `sidekick/agents/*.agent.md`: defines reusable agent personas with instructions, model preference, enabled tools, and enabled skills.
- `sidekick/prompts/*.prompt.md`: defines reusable prompt templates and can auto-select an agent.
- `sidekick/skills/<name>/SKILL.md`: defines reusable skills with instructions and optional bundled resources.
- `sidekick/tools/mcp.json`: defines MCP servers and optional `${input:...}` variables.
- `sidekick/triggers/*.trigger.md`: defines scheduled or file-glob-driven automations.

This means Sidekick is already close to the Copilot mental model of agents, prompts, skills, tools, and workflows. The main difference is the file discovery locations and the exact metadata supported.

---

## 2. Current Architecture Summary

The main customization-relevant areas of this plugin are:

- `src/copilot.ts`: wraps `@github/copilot-sdk`, manages connections, sessions, models, auth, one-shot chat, and persistent sessions.
- `src/settings.ts`: stores Sidekick settings, including the base `sidekickFolder`, provider settings, model settings, and helper folder derivation.
- `src/configLoader.ts`: parses `*.agent.md`, `*.prompt.md`, `SKILL.md`, `mcp.json`, and `*.trigger.md` from the vault.
- `src/view/sessionConfig.ts`: maps agent, skill, MCP server, attachment, and prompt state into the SDK session configuration.
- `src/triggerScheduler.ts`: runs cron triggers and file-glob triggers.
- `src/bots/telegramBot.ts`: reuses agents, skills, and MCP server configs for Telegram conversations.

This architecture matters because it makes Sidekick more like a local Copilot runtime inside Obsidian than a simple prompt box.

---

## 3. Compatibility Matrix

The table below lists the main GitHub Copilot customization mechanisms as of March 2026 and whether they can be used in this Obsidian setup.

| Copilot mechanism | Official file/location | Supported by GitHub Copilot | Directly loaded by Sidekick | Best Sidekick mapping |
| --- | --- | --- | --- | --- |
| Repository-wide instructions | `.github/copilot-instructions.md` | VS Code, GitHub, review flows | No | Convert into a base agent or shared prompt text |
| Path-specific instructions | `.github/instructions/**/*.instructions.md` | VS Code, GitHub coding agent/code review | No | Convert into triggers plus folder-scoped agents |
| Personal instructions | GitHub account-level setting | GitHub.com chat | No | Manually mirror into your preferred agents/prompts |
| Organization instructions | GitHub org-level setting | GitHub.com, some org Copilot flows, VS Code discovery | No | Mirror into a shared vault skill or shared agent boilerplate |
| AGENTS.md | `AGENTS.md` root or nested folders | VS Code, GitHub agent flows | No | Treat as master design doc; translate into `.agent.md` files |
| CLAUDE.md | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` | VS Code compatibility, Claude workflows | No | Use as source material for Sidekick agents or prompts |
| GEMINI.md | repo root on GitHub agent side | GitHub.com agent instructions | No | Use as a cross-tool instruction source only |
| Prompt files | `.github/prompts/*.prompt.md` | VS Code | No | Convert almost directly into `sidekick/prompts/*.prompt.md` |
| Custom agents | `.github/agents/*.agent.md`, `.claude/agents/*.md` | VS Code | Partially analogous | Convert into `sidekick/agents/*.agent.md` |
| Agent skills | `.github/skills/*/SKILL.md`, `.claude/skills`, `.agents/skills` | VS Code, Copilot CLI, coding agent | Yes in concept | Use `sidekick/skills/*/SKILL.md` |
| Hooks | `.github/hooks/*.json`, `.claude/settings*.json` | VS Code preview, Claude-compatible flows | No | Emulate with triggers, MCP servers, or external automation |
| MCP server config | VS Code MCP settings / tools | VS Code and agent flows | Yes | Use `sidekick/tools/mcp.json` |
| Agent handoffs/workflows | `.agent.md` frontmatter handoffs | VS Code | No direct parser | Emulate with prompt chaining and trigger-based workflows |
| Slash-command workflows | prompt files and skills | VS Code | Yes in concept | Use Sidekick prompts and skills |

The key takeaway is that Sidekick natively supports the **same categories** that modern Copilot emphasizes: instructions, agents, prompts, skills, tools, and workflows. It just expresses them in a vault-first format.

---

## 4. Official Copilot Customizations and How They Translate

### 4.1 Repository-wide instructions

Official Copilot file:

```text
.github/copilot-instructions.md
```

Purpose in Copilot:

- Always-on repository guidance.
- Good for architecture, coding rules, naming conventions, build steps, and validation expectations.

What to do in Sidekick:

- Sidekick does not auto-load this file.
- The best translation is to create one or both of these:
- Create a base `General.agent.md` file in `sidekick/agents/`.
- Create a `repo-context.prompt.md` file in `sidekick/prompts/`.

Recommended Sidekick use in this repo:

- Put plugin architecture guidance here: Obsidian plugin lifecycle, `src/` module boundaries, strict TypeScript, release artifacts, and the difference between local GitHub auth and BYOK providers.
- Add explicit reminders about `main.ts` staying small, settings persistence, and vault-safe behavior.

Suggested pattern:

```text
sidekick/agents/obsidian-plugin.agent.md
```

That agent should contain the equivalent of repository-wide instructions for this plugin.

### 4.2 Path-specific instructions

Official Copilot files:

```text
.github/instructions/*.instructions.md
.claude/rules/*.md
```

Purpose in Copilot:

- Apply conventions to particular folders or file types.
- Useful for docs, tests, UI code, backend code, or generated files.

What to do in Sidekick:

- Translate these into either folder-specific agents or `*.trigger.md` files with `glob` patterns.

Good Obsidian mappings:

- `docs/**/*.md` -> documentation editor agent
- `src/view/**/*.ts` -> UI-focused agent
- `src/bots/**/*.ts` -> Telegram and integration agent
- `src/**/*.ts` -> TypeScript plugin maintainer agent

For this repository, triggers are a strong fit because Sidekick already supports:

- `glob` for file matching
- `agent` selection in the trigger frontmatter
- scheduled automations via `cron`

Example idea:

```yaml
---
name: Docs reviewer
agent: Docs
glob: "docs/**/*.md"
enabled: true
---
Review this documentation change for clarity, accuracy, and consistency with the plugin behavior.
```

### 4.3 Personal instructions

Official Copilot mechanism:

- Personal instructions on GitHub.com apply to your own chat experience.

Typical uses:

- preferred language
- concise style
- default output format
- preferred example language

What to do in Sidekick:

- Sidekick has no separate personal-instructions file format.
- Mirror these preferences inside your most frequently used agents.

Practical approach:

- Create one `My Default.agent.md` for your personal style.
- Keep project policy separate from personal tone and response preferences.

This separation prevents your personal writing style from polluting automation-oriented agents such as note triage or daily planning.

### 4.4 Organization instructions

Official Copilot mechanism:

- Organization-level instructions are shared across repositories in GitHub Copilot.

What to do in Sidekick:

- If you use this plugin across many vaults, create a portable skill directory you reuse between vaults.
- Skills are a better translation than prompts because they can bundle examples, templates, and scripts.

Good examples for Obsidian:

- a shared `zettelkasten-writing` skill
- a shared `meeting-note-normalizer` skill
- a shared `research-synthesis` skill

### 4.5 AGENTS.md

Official Copilot mechanism:

- `AGENTS.md` is now supported as always-on agent guidance.
- VS Code supports root `AGENTS.md`, and experimental nested `AGENTS.md` in subfolders.
- GitHub agent flows also support `AGENTS.md`, with nearest-file precedence in the directory tree.

What to do in Sidekick:

- Sidekick does not parse `AGENTS.md` directly.
- Use it as a high-level design source, then split it into Sidekick-native `.agent.md` files.

Why this is useful in Obsidian:

- `AGENTS.md` is often too broad for note work.
- In a vault, narrower agent personas are usually better than one global instruction document.

Recommended conversion strategy:

- `AGENTS.md` section about codebase maintenance -> `obsidian-plugin.agent.md`
- `AGENTS.md` section about writing docs -> `docs.agent.md`
- `AGENTS.md` section about research note synthesis -> `research.agent.md`
- `AGENTS.md` section about daily planning -> `planner.agent.md`

### 4.6 CLAUDE.md

Official Copilot mechanism:

- VS Code now supports `CLAUDE.md` as an always-on instruction source for compatibility with Claude Code and similar tools.
- VS Code also recognizes `.claude/rules`, `.claude/agents`, and Claude-style hooks/settings.

What to do in Sidekick:

- Sidekick does not auto-read `CLAUDE.md`.
- But Sidekick is a good place to **reuse the ideas** inside it.

Practical use in this repo:

- Keep `CLAUDE.md` as the cross-tool canonical guidance if you work in VS Code, Claude Code, and Obsidian.
- Mirror only the task-specific parts into Sidekick agents and skills.

Good rule of thumb:

- keep portable policy in `CLAUDE.md`
- keep Obsidian workflow behavior in `sidekick/`

### 4.7 GEMINI.md

Official Copilot mechanism:

- GitHub documentation now references `GEMINI.md` as another supported agent-instruction source in some GitHub agent flows.

What to do in Sidekick:

- Treat it the same way as `CLAUDE.md` or `AGENTS.md`: useful as a source document, not a file that Sidekick will parse directly.

### 4.8 Prompt files

Official Copilot files:

```text
.github/prompts/*.prompt.md
```

Purpose in Copilot:

- reusable slash-command prompts
- one-shot workflows
- lightweight automation

This is the closest direct analogue to Sidekick prompt files.

Sidekick-native format:

```text
sidekick/prompts/*.prompt.md
```

Supported metadata in Sidekick today:

- `agent`
- `description`

What Sidekick does not currently parse from VS Code prompt files:

- `tools`
- `model`
- `argument-hint`
- built-in prompt variables like `${selection}`

Still, the content is very portable. Most VS Code prompt files can be copied into Sidekick with small edits.

Excellent prompt ideas for this Obsidian setup:

- `refactor-note.prompt.md`: rewrite a note into atomic Zettelkasten form
- `daily-review.prompt.md`: summarize open tasks, journal pages, and meeting notes
- `plugin-release-check.prompt.md`: review manifest, version, and release notes
- `meeting-followup.prompt.md`: turn raw meeting notes into tasks and decisions
- `literature-digest.prompt.md`: create a structured digest from imported paper notes

### 4.9 Custom agents

Official Copilot files:

```text
.github/agents/*.agent.md
.claude/agents/*.md
```

Purpose in Copilot:

- persistent persona
- tool restrictions
- model preference
- handoffs
- optional hooks

Sidekick-native format:

```text
sidekick/agents/*.agent.md
```

Supported metadata in Sidekick today:

- `name`
- `description`
- `model`
- `tools`
- `skills`

What Sidekick does not currently parse from VS Code custom agents:

- `handoffs`
- `hooks`
- `user-invocable`
- `disable-model-invocation`
- `agents` for subagent allow-lists
- `target`

This still maps very well conceptually.

Strong agent candidates for this vault:

- `Docs.agent.md`: writes concise docs and upgrade notes
- `Research.agent.md`: synthesizes papers, notes, highlights, and open questions
- `Planner.agent.md`: daily and weekly planning agent
- `Inbox.agent.md`: turns scratch notes into structured notes or tasks
- `Sidekick-Maintainer.agent.md`: edits this plugin repo safely
- `Telegram-Concierge.agent.md`: optimized for short responses and mobile capture

### 4.10 Skills

Official Copilot files:

```text
.github/skills/<skill>/SKILL.md
.claude/skills/<skill>/SKILL.md
.agents/skills/<skill>/SKILL.md
```

Purpose in Copilot:

- portable capability package
- task-specific instructions
- optional resource files and examples
- shared across VS Code, Copilot CLI, and coding agent

Sidekick-native format:

```text
sidekick/skills/<skill>/SKILL.md
```

This is effectively a direct match.

Sidekick-supported skill metadata today:

- `name`
- `description`

Copilot skill metadata that Sidekick does not currently use:

- `argument-hint`
- `user-invocable`
- `disable-model-invocation`

Skills are one of the best investments for Obsidian because they let you keep your knowledge workflow procedural without making every agent bloated.

High-value skills for a note vault:

- `daily-planning`: generate a daily plan from tasks, calendar notes, and priorities
- `weekly-review`: summarize the week and identify loose ends
- `literature-synthesis`: compare papers, extract claims, and produce evergreen notes
- `meeting-extraction`: convert rough notes into decisions, actions, and owners
- `zettelkasten-refactor`: split a long note into linked atomic notes
- `obsidian-plugin-release`: run a release checklist for this plugin
- `foundry-local-operator`: help configure local models and compare latency/quality tradeoffs

### 4.11 Hooks

Official Copilot files:

```text
.github/hooks/*.json
.claude/settings.json
.claude/settings.local.json
```

Purpose in Copilot:

- deterministic lifecycle automation
- block dangerous actions
- run formatters/tests after edits
- inject context or audit logs

Sidekick status:

- Sidekick does **not** currently parse hook files.
- There is no built-in equivalent of Copilot hook events such as `PreToolUse`, `PostToolUse`, or `Stop`.

Closest Sidekick equivalents:

- `*.trigger.md` for vault-file and scheduled automation
- MCP servers for controlled external tool access
- external OS-level automation outside the plugin

Creative translation ideas for Obsidian:

- use a file-glob trigger on `Inbox/**/*.md` to prompt the agent to classify and clean new notes
- use a `cron` trigger to produce a morning agenda at 8:00
- use MCP tools for search, calendar, or external task system integration
- use a separate watchdog script outside Sidekick if you need true deterministic command execution

### 4.12 Workflows, handoffs, and orchestration

Modern Copilot workflows are usually assembled from:

- custom agents
- prompt files
- skills
- handoffs between agents
- hooks
- MCP tools

Sidekick does not yet support VS Code-style `handoffs` in `.agent.md`, but it does support workflow composition in other ways.

Best workflow primitives in Sidekick:

- agent selection
- prompt templates
- skill directories
- vault scope selection
- triggers with `glob` and `cron`
- MCP tools via `mcp.json`
- search sessions
- Telegram bot sessions with a default agent

That is enough to build very capable workflows inside a vault.

---

## 5. Sidekick-Native File Formats

### 5.1 Agent files

File:

```text
sidekick/agents/<name>.agent.md
```

Supported frontmatter:

```yaml
---
name: Grammar
description: Improve wording, structure, and clarity
tools:
    - github
skills:
    - literature-synthesis
model: Claude Sonnet 4.5
---
```

The body becomes the agent instructions.

Use this for:

- persona
- default tone
- task boundaries
- preferred skills and MCP tools

### 5.2 Prompt files

File:

```text
sidekick/prompts/<name>.prompt.md
```

Supported frontmatter:

```yaml
---
agent: Research
description: Turn raw highlights into a digest
---
```

The body becomes prompt content prepended to the user message.

Use this for:

- repeatable one-shot tasks
- slash-command equivalents
- workflow shortcuts

### 5.3 Skill files

File:

```text
sidekick/skills/<skill-name>/SKILL.md
```

Supported frontmatter:

```yaml
---
name: literature-synthesis
description: Compare papers, extract claims, and build evergreen notes
---
```

Use this for:

- procedures
- example inputs/outputs
- templates
- domain playbooks

### 5.4 Trigger files

File:

```text
sidekick/triggers/<name>.trigger.md
```

Supported frontmatter:

```yaml
---
name: Daily planner
description: Create a morning plan
agent: Planner
cron: "0 8 * * *"
glob: "Daily/**/*.md"
enabled: true
---
```

Use this for:

- schedule-driven prompts
- file-change automations
- folder-specific behavior

### 5.5 MCP tools

File:

```text
sidekick/tools/mcp.json
```

Sidekick supports both:

```json
{
    "servers": { ... }
}
```

and:

```json
{
    "mcpServers": { ... }
}
```

It also supports `inputs` and `${input:...}` placeholder resolution.

Use this for:

- external search
- calendars
- task systems
- local scripts exposed as MCP
- constrained integrations instead of broad shell execution

---

## 6. What Is Directly Reusable vs What Needs Translation

### Directly reusable with little or no change

- `SKILL.md` content and structure
- most `.prompt.md` bodies
- most `.agent.md` bodies
- Claude/AGENTS instruction text as source material

### Reusable after small translation

- VS Code custom agents -> remove unsupported frontmatter such as `handoffs`, `hooks`, `user-invocable`
- prompt files -> remove unsupported frontmatter such as `tools`, `model`, `argument-hint`
- `.instructions.md` -> move logic into Sidekick agents or trigger-based folder automations

### Not directly supported by Sidekick today

- automatic loading of `.github/copilot-instructions.md`
- automatic loading of `.github/instructions/*.instructions.md`
- automatic loading of `AGENTS.md`
- automatic loading of `CLAUDE.md`
- automatic loading of `GEMINI.md`
- hook JSON lifecycle events
- agent handoff buttons
- organization-level or personal GitHub Copilot settings

---

## 7. Best Creative Applications for This Obsidian Setup

This plugin is especially well suited to note-centric workflows that standard repository customizations do not cover very well.

### 7.1 Knowledge-area agents for small vaults

Create one agent per knowledge domain:

- `Programming.agent.md`
- `Philosophy.agent.md`
- `Research.agent.md`
- `Writing.agent.md`
- `Planner.agent.md`

Pair each with vault scope so the same Copilot backend behaves differently depending on the selected folder.

This is the Obsidian analogue of nested `AGENTS.md` or path-specific instructions, but with explicit control.

This works best when you only have a few domains.

If you expect many domains and many role agents, the more scalable pattern is the one in section 7.10: keep role agents separate and model domains as reusable skills.

### 7.2 Note lifecycle workflows

Use prompts to turn capture into structure:

- `capture-to-note.prompt.md`
- `note-to-zettel.prompt.md`
- `zettel-to-outline.prompt.md`
- `outline-to-article.prompt.md`

This creates a deliberate writing pipeline instead of a generic chatbot.

### 7.3 Inbox processing trigger

Put rough notes in `Inbox/` and use a trigger:

```yaml
---
name: Inbox triage
agent: Inbox
glob: "Inbox/**/*.md"
enabled: true
---
Classify this note, suggest a permanent home, extract tasks, and propose a cleaned-up title.
```

This is a strong replacement for file-based instructions because the behavior becomes active exactly when new notes arrive.

### 7.4 Daily and weekly review automations

Use cron triggers:

- morning planning at 08:00
- evening shutdown at 18:00
- weekly review every Sunday

This is a good example of Sidekick doing something Copilot repository instructions cannot do by themselves.

### 7.5 Research synthesis skill pack

Create a `literature-synthesis` skill with:

- `SKILL.md`
- claim extraction template
- comparison matrix template
- note naming convention examples
- citation formatting examples

This is an excellent use of skills because the domain logic is procedural and reusable.

### 7.6 Plugin maintenance agent for this repo

Create a `Sidekick-Maintainer.agent.md` that encodes:

- Obsidian plugin packaging expectations
- `src/main.ts` should stay thin
- use `npm`
- prefer minimal changes
- keep build output out of version control
- remember `manifest.json`, `versions.json`, and release artifacts

This is effectively the Sidekick-local version of `.github/copilot-instructions.md` for the plugin itself.

### 7.7 Foundry Local and offline knowledge work

This repository already supports a `foundry-local` provider preset.

That opens a useful pattern:

- use GitHub models or Anthropic for coding tasks
- use Foundry Local for private note synthesis and daily journaling

You can reflect that split in agent definitions by setting different model names in different Sidekick agents.

### 7.8 Telegram as a mobile workflow endpoint

Because the Telegram bot reuses Sidekick agents and skills, you can build low-friction mobile workflows:

- `Telegram-Concierge.agent.md` for quick answers
- `Capture.agent.md` for voice-note cleanup and task extraction
- `Planner.agent.md` for mobile daily review

This is a creative extension of Copilot agent ideas into a note system that follows you outside the editor.

### 7.9 A memory agent for Sidekick customization

Your first request fits Sidekick well if you model it as a shared skill plus a dedicated agent.

Recommended pattern today:

- Put the durable knowledge in one skill such as `sidekick-config-memory`.
- Put the editing behavior in one agent such as `Sidekick-Customization-Maintainer.agent.md`.
- Let other agents share the same skill when they need awareness of Sidekick's config model.

Why this split works:

- the skill holds stable reference knowledge about the Sidekick folder layout and supported frontmatter
- the agent holds the behavior for proposing or applying improvements
- multiple agents can reuse the same skill without duplicating configuration knowledge

Suggested files:

```text
sidekick/
    agents/
        sidekick-customization-maintainer.agent.md
    prompts/
        improve-sidekick-config.prompt.md
        add-domain-pack.prompt.md
    skills/
        sidekick-config-memory/
            SKILL.md
            agent-template.md
            prompt-template.md
            trigger-template.md
            mcp-example.json
```

Example skill:

```yaml
---
name: sidekick-config-memory
description: Reference knowledge for how Sidekick loads agents, prompts, skills, tools, and triggers
---
```

Example skill body:

```md
# Sidekick configuration memory

Remember these current Sidekick rules:

- agents live in `sidekick/agents/*.agent.md`
- prompts live in `sidekick/prompts/*.prompt.md`
- skills live in `sidekick/skills/<skill>/SKILL.md`
- tools live in `sidekick/tools/mcp.json`
- triggers live in `sidekick/triggers/*.trigger.md`

Supported metadata today:

- agents: `name`, `description`, `model`, `tools`, `skills`
- prompts: `agent`, `description`
- triggers: `name`, `description`, `agent`, `cron`, `glob`, `enabled`

When asked to improve Sidekick customization, prefer config-only changes first.
Escalate to a product feature only when the request needs agent delegation, hooks, or automatic domain detection.
```

Example maintainer agent:

```yaml
---
name: Sidekick Customization Maintainer
description: Improves Sidekick agents, prompts, skills, tools, and triggers with config-first changes
skills:
    - sidekick-config-memory
model: GPT-5.4
---
```

This gets you a usable memory agent now.

Important limitation:

- Sidekick can load that agent and you can select it directly.
- Other agents can share its skill.
- But Sidekick does not currently support one agent invoking another agent as a native handoff or subagent call.

So the best current approximation is: shared memory skill plus a dedicated maintainer agent.

### 7.10 Domain skills for knowledge-domain-aware behavior

Your second request also fits the current model, but the clean design is to treat domains as skills, not as a new kind of agent.

Recommended structure today:

- keep role agents focused on job type such as `Researcher`, `Article Producer`, and `Summarizer`
- create one domain skill per knowledge domain
- combine the role agent with one or more domain skills and a matching vault scope

This avoids an explosion of agents such as `Researcher for Domain A`, `Researcher for Domain B`, `Summarizer for Domain A`, and so on.

Good folder blueprint:

```text
sidekick/
    agents/
        researcher.agent.md
        article-producer.agent.md
        summarizer.agent.md
    skills/
        domain-distributed-systems/
            SKILL.md
            source-quality-checklist.md
            article-outline-template.md
        domain-behavioral-economics/
            SKILL.md
            concept-map-template.md
        domain-personal-knowledge-management/
            SKILL.md
            note-review-template.md
```

Example domain skill:

```yaml
---
name: domain-distributed-systems
description: Concepts, terminology, source expectations, and writing heuristics for distributed systems notes
---
```

Example skill body:

```md
# Distributed systems domain pack

Use this domain context when working in the Distributed Systems area of the vault.

Important concepts:

- consistency models
- replication and quorum
- partition tolerance tradeoffs
- failure modes and observability
- latency versus throughput tradeoffs

Behavior rules:

- prefer precise definitions over metaphor
- distinguish mechanism from guarantee
- call out assumptions and failure boundaries
- ask for the system model when claims are underspecified
```

How to use this in Sidekick today:

1. Select the role agent, for example `Researcher`.
2. Enable the relevant domain skill, for example `domain-distributed-systems`.
3. Limit vault scope to the domain folder when appropriate.
4. Use prompts to standardize recurring actions such as summarize, outline, critique, or expand.

This gives you domain-adaptive behavior now for agents such as a researcher, article producer, or summarizer without changing plugin code.

Where current config stops being enough:

- when you want Sidekick to infer the domain automatically from the active note, folder, or frontmatter
- when you want conflicts resolved across multiple matching domains
- when you want one agent to call the configuration memory agent automatically before answering

Those gaps are product-feature territory rather than documentation or config work. See `docs/domain-context-and-agent-delegation-prd.md` for a concrete proposal.

---

## 8. Recommended Folder Blueprint for This Vault

If you want this vault to feel like a well-customized Copilot workspace inside Obsidian, this is a good starting point:

```text
sidekick/
    agents/
        sidekick-maintainer.agent.md
        sidekick-customization-maintainer.agent.md
        docs.agent.md
        research.agent.md
        planner.agent.md
        inbox.agent.md
        telegram-concierge.agent.md
    prompts/
        capture-to-note.prompt.md
        literature-digest.prompt.md
        daily-review.prompt.md
        plugin-release-check.prompt.md
        docs-review.prompt.md
    skills/
        sidekick-config-memory/
            SKILL.md
            agent-template.md
        literature-synthesis/
            SKILL.md
            comparison-template.md
        domain-distributed-systems/
            SKILL.md
        domain-behavioral-economics/
            SKILL.md
        zettelkasten-refactor/
            SKILL.md
            atomic-note-template.md
        obsidian-plugin-release/
            SKILL.md
            release-checklist.md
        meeting-extraction/
            SKILL.md
            action-log-template.md
    tools/
        mcp.json
    triggers/
        inbox-triage.trigger.md
        daily-planner.trigger.md
        weekly-review.trigger.md
        docs-review.trigger.md
```

This is the closest practical equivalent to using:

- repository instructions
- file-based instructions
- prompt files
- custom agents
- skills
- workflow automation

inside an Obsidian-native environment.

---

## 9. Migration Rules of Thumb

If you already have Copilot customization files elsewhere, use these rules.

### If you have `.github/copilot-instructions.md`

- Move global policy into one main Sidekick agent.
- Split workflow-specific content into skills.

### If you have `.github/instructions/*.instructions.md`

- Convert each rule set into either:
- a domain agent.
- a trigger with `glob`.
- a prompt dedicated to that folder/type.

### If you have `.github/prompts/*.prompt.md`

- Copy the prompt body into `sidekick/prompts/`
- keep `agent` and `description`
- drop unsupported prompt metadata unless the plugin adds it later

### If you have `.github/agents/*.agent.md`

- Copy the instruction body
- keep `name`, `description`, `model`, `tools`, and `skills`
- remove `handoffs`, `hooks`, and other unsupported metadata

### If you have `.github/skills/*/SKILL.md`

- Copy them almost directly into `sidekick/skills/`
- keep the folder-per-skill structure
- include extra templates and examples in the skill directory

### If you have `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`

- treat them as cross-tool policy documents
- split them into smaller Sidekick-native pieces rather than trying to preserve them as one global file

---

## 10. Limitations and Reality Check

There are three important boundaries to remember.

### 10.1 Sidekick is not a generic VS Code customization loader

It does not crawl `.github/`, `.claude/`, or repository root instruction files.

### 10.2 Sidekick supports a narrower metadata model than full VS Code Copilot customization

Today, Sidekick agents and prompts use a smaller subset of fields than official VS Code prompt and agent files.

### 10.3 Sidekick gains power from Obsidian-specific concepts that Copilot does not natively model

These include:

- vault scope
- note folders as knowledge domains
- scheduled note workflows
- note-creation triggers
- Telegram note capture

So the goal should not be to mirror GitHub Copilot file support perfectly. The goal should be to adapt Copilot's best customization concepts into a vault-native system.

### 10.4 There is no first-class agent delegation yet

An agent can be selected by the user, by a prompt, by a trigger, or by the Telegram bot default.

But one Sidekick agent cannot currently invoke another agent as a native handoff or subagent call.

That means a memory agent can exist today as a selectable agent and as a shared skill, but not as an internal delegate used automatically by other agents.

### 10.5 There is no automatic domain-to-skill resolution yet

Sidekick does not currently infer a domain from:

- the active note path
- the selected vault scope
- note frontmatter
- folder conventions
- tags

Domain-aware behavior today is assembled manually through agent selection, skill selection, prompts, and triggers.

---

## 11. Recommended Strategy for This Repository

For `obsidian-sidekick`, the most effective setup is:

1. Put plugin-maintenance instructions into one main Sidekick agent.
2. Add one Sidekick customization memory skill plus an optional dedicated maintainer agent for config evolution.
3. Keep role agents separate from knowledge domains.
4. Model knowledge domains as reusable skills and combine them with role agents and vault scope.
5. Build skills for repeatable procedures such as weekly reviews and plugin releases.
6. Use prompts for frequent one-shot actions.
7. Use triggers for scheduled and folder-based automation.
8. Use MCP tools for external integrations instead of broad, uncontrolled automation.
9. Keep any `AGENTS.md` or `CLAUDE.md` files as optional cross-tool source documents, not as the primary runtime format for Sidekick.

If you follow that structure, this Obsidian setup can express nearly all of the useful GitHub Copilot customization patterns, even when the original file formats are not loaded directly.

---

## 12. Short Version

What works best in this Obsidian setup:

- **Use Sidekick agents as the equivalent of Copilot custom agents and repository instructions.**
- **Use Sidekick prompts as the equivalent of Copilot prompt files.**
- **Use Sidekick skills as the equivalent of Copilot skills.**
- **Keep Sidekick configuration knowledge in a shared skill, then optionally wrap it in a dedicated maintainer agent.**
- **Model knowledge domains as reusable skills that you combine with role agents such as researcher, article producer, and summarizer.**
- **Use Sidekick triggers as the equivalent of folder-specific instructions plus lightweight workflow automation.**
- **Use `mcp.json` as the equivalent of tool and MCP configuration.**
- **Treat `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` as source material, not directly loaded runtime files.**

If you want agent-to-agent delegation or automatic domain inference, that requires a new Sidekick feature rather than more documentation.

That is the cleanest, most maintainable way to bring the modern GitHub Copilot customization model into Obsidian Sidekick.
