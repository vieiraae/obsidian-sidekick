# PRD: Domain Context Packs and Agent Delegation

## 1. Summary

Sidekick already supports agents, prompts, skills, triggers, and MCP tools through vault-local configuration.

That is enough to approximate two requested capabilities:

- a memory agent for maintaining Sidekick customization
- domain-aware behavior for role agents such as researcher, article producer, and summarizer

But two important gaps remain:

- Sidekick cannot automatically activate domain context based on the current note, folder, or vault scope.
- Sidekick cannot let one agent invoke another agent as a native delegate or handoff.

This PRD proposes first-class support for both capabilities while preserving the current config model.

## 2. Problem

Users with large knowledge vaults organize notes by domain.

They want role agents to adapt to the active domain without maintaining a combinatorial set of agents such as:

- Researcher for domain A
- Researcher for domain B
- Summarizer for domain A
- Article Producer for domain B

They also want a stable Sidekick customization expert that knows the plugin's configuration model and can be consulted by other agents when new prompts, skills, triggers, or tool integrations are needed.

Current Sidekick configuration can approximate this by combining:

- role agents
- reusable skills
- prompts
- vault scope
- triggers

That works, but it has two limitations:

1. domain selection is manual
2. agent delegation is manual

As the number of domains grows, manual assembly becomes error-prone and inconsistent.

## 3. Goals

1. Let Sidekick infer and activate domain-specific context automatically.
2. Let Sidekick role agents delegate to a specialized memory agent when configuration expertise is required.
3. Preserve compatibility with the existing `sidekick/agents`, `sidekick/prompts`, `sidekick/skills`, `sidekick/tools`, and `sidekick/triggers` layout.
4. Keep the feature understandable for non-programmer vault owners.
5. Avoid forcing users to duplicate content across many domain-specific agents.

## 4. Non-goals

1. Full parity with VS Code custom-agent features such as hooks or arbitrary orchestration graphs.
2. A generic workflow engine.
3. Automatic file editing without user confirmation.
4. Replacing the current skill system.

## 5. User Stories

### 5.1 Domain adaptation

- As a vault owner, I want a `Researcher` agent to behave differently in `Domains/Distributed Systems/` than in `Domains/Behavioral Economics/` without creating separate agents for each domain.
- As a writer, I want `Article Producer` to pick the correct vocabulary, evidence standards, and output structure for the current domain automatically.
- As a summarizer, I want summaries to reflect the expectations of the active domain, such as stronger source criticism in research-heavy areas.

### 5.2 Memory agent

- As a Sidekick power user, I want a dedicated configuration-maintainer agent that knows Sidekick's file formats and limitations.
- As another agent, I want to hand off configuration design tasks to that specialist and receive a structured answer back.
- As a user, I want the memory agent to recommend config-only changes first and propose product changes only when config is insufficient.

## 6. Proposed Solution

The feature has two parts.

### 6.1 Domain context packs

Introduce a new optional folder:

```text
sidekick/domains/
    <domain-name>/
        DOMAIN.md
        ...optional templates/resources...
```

`DOMAIN.md` defines:

- domain name
- description
- matching rules
- instructions to inject when active
- optional default skills
- optional preferred agents
- optional prompt hints

Proposed frontmatter:

```yaml
---
name: distributed-systems
description: Domain context for distributed systems notes
match:
    folders:
        - "Domains/Distributed Systems/**"
    tags:
        - distributed-systems
    frontmatter:
        domain: distributed-systems
defaultSkills:
    - domain-distributed-systems
preferredAgents:
    - Researcher
    - Article Producer
priority: 100
---
```

Behavior:

- When the user selects a vault scope, opens a note, or starts a session with attachments, Sidekick resolves matching domains.
- The selected domain instructions are added to the session context.
- The domain's default skills are auto-enabled unless the user explicitly disables them.
- If more than one domain matches, Sidekick resolves ties by priority and then prompts the user when ambiguity remains.

### 6.2 Agent delegation

Extend agent files to support optional delegation metadata.

Proposed agent frontmatter:

```yaml
---
name: Researcher
description: Research and synthesis specialist
skills:
    - literature-synthesis
delegates:
    - Sidekick Customization Maintainer
---
```

Behavior:

- An agent may ask Sidekick to invoke a named delegate agent.
- The delegate runs with its own instructions, skills, tools, and model preference.
- The delegate returns either:
  - a short answer to merge into the current response
  - a structured artifact such as config recommendations
- Delegation is visible in the UI so the user knows another agent was consulted.

## 7. UX

### 7.1 Session setup

- If a domain is inferred confidently, show a session badge such as `Domain: Distributed Systems`.
- If multiple domains match, show a picker before first message send.
- Show auto-enabled skills separately from manually enabled skills.

### 7.2 Chat behavior

- When a role agent delegates, show a compact status row such as `Researcher consulted Sidekick Customization Maintainer`.
- Let users expand the delegate reasoning or keep it collapsed.
- Let users disable delegation per session.

### 7.3 Settings

Add settings for:

- enable automatic domain detection
- prefer folder match, frontmatter match, or tag match
- require confirmation before auto-enabling domain skills
- allow or block agent delegation globally

## 8. File Format Details

### 8.1 New domain file type

New loader target:

```text
sidekick/domains/<name>/DOMAIN.md
```

Required metadata:

- `name`

Optional metadata:

- `description`
- `match.folders`
- `match.tags`
- `match.frontmatter`
- `defaultSkills`
- `preferredAgents`
- `priority`

The body becomes injected domain instructions.

### 8.2 Agent delegation metadata

New optional agent metadata:

- `delegates`

Future-compatible but not required now:

- `delegateMode`
- `delegatePromptTemplate`
- `userInvocable`

## 9. Implementation Notes

### 9.1 Loader changes

- Add a `loadDomains` function alongside `loadAgents`, `loadSkills`, `loadPrompts`, and `loadTriggers`.
- Extend the frontmatter parser or add a safe parser path for nested metadata because domain matching will need structured fields.
- Extend `AgentConfig` with optional `delegates`.

### 9.2 Session composition

- Update session configuration assembly so active domain instructions are injected into the session before the first user message.
- Merge auto-enabled domain skills with manual skill selection using explicit precedence rules.
- Preserve user overrides.

### 9.3 Context resolution

Domain inference sources should include:

- active file path
- selected vault scope
- current attachments
- note frontmatter
- note tags

Matching algorithm:

1. explicit user domain selection
2. frontmatter match
3. folder or glob match
4. tag match
5. priority tie-break
6. user confirmation when still ambiguous

### 9.4 Delegation execution

- Reuse the existing chat/session infrastructure for delegate invocations.
- Limit delegates to an allow-list from the agent config.
- Make delegation opt-in and observable.
- Prevent infinite loops by tracking delegate depth and disallowing cycles.

## 10. Risks

1. Wrong domain inference could silently bias answers.
2. Hidden delegation could make the system feel unpredictable.
3. Domain instructions may become too large and hurt latency or quality.
4. Simple frontmatter parsing may be insufficient for nested matching metadata.

## 11. Mitigations

1. Always expose the active domain in the UI.
2. Require confirmation for ambiguous matches.
3. Cap injected domain content and recommend moving large references into skill resources.
4. Enforce a maximum delegation depth of 1 in the first release.
5. Add validation for bad domain configs and missing delegate names.

## 12. Acceptance Criteria

1. A user can define at least one `DOMAIN.md` file and see its domain badge become active for matching notes or scopes.
2. When a domain becomes active, its instructions are injected and its default skills are enabled.
3. A user can override or disable the inferred domain for the current session.
4. An agent can reference an allowed delegate agent in its frontmatter.
5. Delegate execution is visible in the UI and cannot recurse indefinitely.
6. Existing agents, prompts, skills, triggers, and MCP config continue to work without modification.

## 13. Rollout Plan

### Phase 1

- ship domain file loading
- show active domain badge
- inject domain instructions
- auto-enable default domain skills

### Phase 2

- ship explicit agent delegation with UI visibility
- add depth protection and validation

### Phase 3

- add optional prompt templates for delegate requests
- add richer ambiguity resolution and domain suggestions

## 14. Interim Guidance Before This Ships

Until this feature exists, the recommended configuration pattern is:

1. Create one shared `sidekick-config-memory` skill.
2. Optionally create one `Sidekick Customization Maintainer` agent that uses that skill.
3. Keep role agents separate from domains.
4. Model each knowledge domain as a reusable skill.
5. Combine role agent + domain skill + vault scope manually.

That gives users most of the desired behavior now, while this PRD covers the gaps that require plugin changes.
