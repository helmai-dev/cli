# Consented device-borrow vs Anthropic and OpenAI terms

Checked 2026-08-31 against public terms, not legal advice. Question from the Ben call: can Helm, with the host’s consent, run another engineer’s turn on that host’s already-logged-in Claude Code or Codex so leftover subscription quota is used?

**Verdict.** Do not ship device-borrow against consumer Pro/Max/Plus seats, and do not ship it against Team seats that are billed per member. The official pooling products are org API keys and (for OpenAI) workspace credit pools. Wrap reuse stays the legal skip: no one else’s seat is used.

## What we would be doing

Not wrap skip. A live model request billed to teammate B’s Claude/Codex login, prompted by teammate A, on B’s machine after B approves a link.

Josh’s “device sharing, not account sharing” split is not a term the providers use. Both treat “make the account available to anyone else” and “each end user authenticates with their own credentials” as the rule.

## Anthropic

### Consumer (Free / Pro / Max, including Claude Code on those plans)

[Consumer Terms](https://www.anthropic.com/legal/consumer-terms), §2:

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.

Consent does not create an exception. Routing A’s work through B’s logged-in Claude Code is making B’s account available to A.

Claude Code docs, [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance.md):

- Pro/Max advertised limits assume **ordinary, individual usage**.
- Third parties may not route requests through Free/Pro/Max credentials **on behalf of their users**, and may not collect, store, or intermediate Claude.ai credentials or session tokens.
- Customers offering Claude Code in a product **may not pay for, resell, or intermediate Claude usage on their end users’ behalf**. Each end user must authenticate with **their own** API key, subscription, or 3P credential.

Helm wrap already forwards the client’s own tokens. Device-borrow would intermediate B’s OAuth/session for A’s prompt. That is the restriction.

### Team / Enterprise / API (commercial)

[Commercial Terms](https://www.anthropic.com/legal/commercial-terms) D.5: Customer is responsible for all activity under its account. D.4: no resale except as Anthropic approves.

[Claude for Work Team](https://support.claude.com/en/articles/9266767-what-is-the-team-plan):

> Usage limits on Team plans are per-member, rather than applied to the team as a whole. … If one team member reaches their seat’s included usage limit, it does not affect the limits of other team members.

Anthropic sells **per-seat** limits. Using B’s remaining 70% so A can keep working is exactly the pooling they priced against. The intended fix is another seat or the API, not a borrow.

[Service-specific terms](https://www.anthropic.com/legal/service-specific-terms) for Claude for Work only add admin-notice and consent duties. They do not allow one User to consume another User’s seat.

## OpenAI (Codex / ChatGPT)

### Consumer (Free / Plus / Pro)

[Terms of Use](https://openai.com/policies/row-terms-of-use/) (effective 2026-01-01):

> You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account.

Also: do not circumvent rate limits or restrictions.

[Account Sharing Policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy) (updated this week):

> Your OpenAI account is meant for you—the individual who created it. If someone else needs to use OpenAI’s products, they should sign up for their own account.

Multiple **devices for the same person** are allowed. Multiple **people on one account** are not.

### Business / Enterprise / API

[OpenAI Services Agreement](https://openai.com/policies/business-terms/) §3.1–3.3:

- Do not share Account access credentials or **individual login credentials between multiple users**.
- Do not resell or lease access to the Account or any End User Account.
- End User Accounts may only be provisioned to, registered for, and **used by, a single End User**.
- Do not violate or circumvent Usage Limits.

The legal team pool is already in product: Enterprise/Edu **flexible pricing draws from a workspace shared credit pool** ([Codex + ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)). That is org-billed usage, not borrowing B’s Plus/Pro seat.

## Team-perspective matrix

| Buyer setup | Device-borrow leftover Max/Plus/seat quota | What is actually allowed |
|---|---|---|
| Individual Pro/Max/Plus | No. “Do not make your account available to anyone else.” | Each person has their own seat. Helm wrap skip on that seat. |
| Claude Team / Enterprise seats | No. Limits are per member by design. | Buy another seat, or move the workload to the org API. |
| OpenAI Business seats | No. One End User per End User Account; no leasing. | Provision that person a seat. |
| OpenAI Enterprise shared credits | Not device-borrow; already pooled. | Route Codex/ChatGPT Work through the workspace. Helm can observe that spend. |
| Org API key (Anthropic Console, OpenAI API, Bedrock, Vertex) | N/A. There is no per-person consumer quota to pinch. | Helm wrap/proxy billed to the org. This is the clean commercial path. |

## What Helm can still do

1. **Wrap reuse** (shipped). Skip a request that already has a stored response. No second seat.
2. **Observe leftover %** on each wrapped seat (Claude/Codex already expose remaining limits). Show the org “Ben usually ends the week with ~30% left” as Diagnose, not as a borrow button.
3. **Recommend the official pool.** If the org is burning three Max seats and leaving ten unused, the product sentence is “move this workload to Team/API,” not “run it on Ben’s laptop.”
4. **Do not** auto-inject “send Ben this link so we can use his Claude.” That is intermediating subscription credentials on another user’s behalf.

## Open questions (need counsel, not more scraping)

- A Team **admin** starting a Claude Code job as a named User via the org’s own admin APIs, if any exist, vs Helm driving the unmodified binary with that User’s OAuth cookie.
- Whether a written Anthropic/OpenAI partnership could allow org-level routing. Today’s public Claude Code rule is: each end user authenticates as themselves; Helm must not intermediate.

Until counsel says otherwise, device-borrow stays a do-not-build. The Thursday story is wrap + no-password install + honest receipts, not token torrenting.
