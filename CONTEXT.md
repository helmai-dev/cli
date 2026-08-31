# Helm Runtime Context

This context defines the language Helm uses when it observes AI work, intervenes in an agent session, and attributes money saved to evidence.

## Language

**AI Workload**:
A model request and its surrounding coding task, evidence, cost, and outcome considered as one unit of work.
_Avoid_: Prompt, chat

**Ambient Intervention**:
A relevant context addition, warning, repair, reuse, or other action Helm introduces during an agent lifecycle without requiring an explicit Helm command.
_Avoid_: Injection, notification

**Team Overlap**:
Evidence that more than one person or agent is working on the same project or path within a relevant time window.
_Avoid_: Collision, duplicate work

**Savings Opportunity**:
Measured AI cost that could be avoided by a proposed intervention but has not yet been avoided.
_Avoid_: Saving, estimated saving

**Verified Saving**:
AI cost that was actually avoided by an Ambient Intervention and is traceable to a measured baseline and outcome evidence.
_Avoid_: Potential saving, projected saving

**Intervention Receipt**:
The auditable record connecting an Ambient Intervention to its prior paid AI Workload, measured baseline, resulting outcome, and any Verified Saving.
_Avoid_: Usage event, analytics row

## Relationships

- An **AI Workload** can produce zero or more **Savings Opportunities**.
- An **Ambient Intervention** can respond to a **Team Overlap** or a **Savings Opportunity**.
- An **Ambient Intervention** produces at most one **Intervention Receipt** for each affected **AI Workload**.
- An **Intervention Receipt** records a **Verified Saving** only when the cost was actually avoided.
- A **Savings Opportunity** never becomes a **Verified Saving** without an **Intervention Receipt**.

## Example dialogue

> **Dev:** "The same context was billed twice. Is that already a Verified Saving?"
> **Domain expert:** "No. It is a Savings Opportunity until an Ambient Intervention avoids the request or measured tokens and records an Intervention Receipt."

## Flagged ambiguities

- "Savings" previously described both identified waste and avoided cost — resolved: use **Savings Opportunity** for measured potential and **Verified Saving** only for cost actually avoided.
- "Prompt" previously stood in for the whole unit of work — resolved: the product analyzes an **AI Workload**, not prompt text alone.
