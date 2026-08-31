# Consented device-borrow vs Anthropic and OpenAI terms

Checked 2026-08-31 against public terms, not legal advice. Question from the Ben call: can Helm, with the host’s consent, run another engineer’s turn on that host’s already-logged-in Claude Code or Codex so leftover subscription quota is used?

**Verdict.** The design is not password-sharing. Credentials stay on B’s machine. The remaining ToS problem is **using B’s per-seat limit so A can keep working after A hit theirs.** Anthropic and OpenAI sell overflow as extra usage / a workspace pool, not as leftover seat multiplexing. Occasional “hey, run this prompt on your Claude” is a coworker favor. A Helm product whose job is to reallocate leftover Max/Team quota is what they price against. Wrap reuse stays the clean skip.

## What we would be doing

Not wrap skip, and not copying B’s login. After B approves, Helm asks the unmodified Claude/Codex on **B’s already-logged-in device** to run a prompt A wrote. B’s OAuth never leaves B’s laptop. From the provider’s billing view, **B** submitted the input.

That is closer to Slack: “here’s a prompt, run this for me.” It is not Netflix-password sharing. The earlier note over-weighted credential sharing. The clauses that still matter are per-seat limits, “ordinary individual usage,” and not circumventing rate limits by moving the work onto another account.

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

## The “run this for me” framing

If B is the user at the keyboard of their own Claude Code, B is using B’s account. Consumer “do not share credentials” is not the hit. Two other rules are:

1. **Per-seat limits are the product.** Claude Team: if one member hits the included limit, others are unaffected — and the official overflow is **extra usage credits at API rates**, plus per-user spend caps ([extra usage](https://support.claude.com/en/articles/12005970-extra-usage-for-claude-for-work-team-and-enterprise-plans)). OpenAI Business: one End User per End User Account; Enterprise flexible pricing already **pools credits at the workspace**. Neither vendor documents “send the blocked turn to a teammate with headroom.”
2. **Circumvention.** OpenAI Terms: do not “circumvent any rate limits or restrictions.” Anthropic AUP: do not “circumvent a ban through the use of a different account” and do not coordinate across accounts to avoid guardrails. If the *reason* the prompt moves from A to B is that A is out of quota, Helm is a system for continuing work the rate limit was meant to stop.

Claude Code’s “ordinary, individual usage” line and “do not intermediate usage on their end users’ behalf” still apply if Helm’s *product* is A’s coding session billed to B’s plan. A one-off human paste is not that. A lend/borrow queue that exists to burn leftover seats is.

**ToS-safer cousin (already in Helm’s daemon/inbound path):** A named **workload** is offered as a link. B accepts. Unmodified Claude/Codex starts **on B’s device as B**. When it finishes, the change (diff, output) comes back through Helm for A to take — like a PR, not like A still being mid-session on B’s Max plan.

That is work assignment, not leftover-quota routing:

| | Quota pinch (do not build) | Workload link (this shape) |
|---|---|---|
| What A sends | “Finish my turn, I hit a limit” | A workload (project, ask, paths) |
| What B does | Lend unused Max | Accept and run it as B |
| Who Anthropic/OpenAI bills | B’s seat, for A’s session | B’s seat, for B’s run |
| What comes back | Streamed completion on A’s chat | Artifact A can copy/apply |
| Helm already has | Nothing honest | Daemon claim + inbound `code-bridge` + work package lifecycle |

Keep matching on “B volunteered / B is the right person,” not “B has 70% left.” Spend on that run is B’s observed spend. A Verified Saving is still only wrap reuse, never “we used Ben’s leftover tokens.”

Until counsel says otherwise, do not build leftover-quota routing. A consent link that starts **B’s** agent on a named workload and returns the diff is the inbound path, not token torrenting. Thursday: wrap + no-password install + honest receipts. Official seat overflow remains extra usage / API / workspace credits.
