# Helm North Star

Locked 2026-08-18 from cofounder feedback (Ben). Use this to evaluate every Helm change in CLI, web, and Helm Code / desktop.

Helm sits between apps and model providers so an engineering org can see its AI requests, find waste, and quantify it. Difference vs a router: a router is access. Helm asks whether you should make this request, on this model, with this context, or reuse work that already exists.

## Keep

- Easy to install. Add it in the terminal and stay in the flow of work.
- Org-wide visibility with a simple dashboard.
- Individual dashboards. We own the data.

## The job

Spend observability alone is not enough.

Not: "You spent $48,075 on AI."

Yes: "You spent $48,075 and we found $11,420 you did not need to spend."

Those dollar amounts are illustrative. Never show them unless computed from real ingested cost. Otherwise null / "Not quantified yet."

## Primary screen (web; CLI must feed it)

- Total AI spend this month
- Avoidable spend identified
- Repeated context / caching opportunity
- Model over-provisioning
- Duplicate AI workloads
- Prompt / token inefficiency
- Review optimizations

## Product progression

Observe → Diagnose → Optimize → Autopilot.

## Unit of analysis

The useful unit is the **AI workload**, not a prompt string. Identify equivalent or overlapping workloads across teams. Prompt caching is one lever, not the product category.

## Marketing line

Find the waste in your AI bill. See it → quantify it → fix it.

## Honesty rules (fail the PR if broken)

Updated 2026-08-21. The excerpt lock in `helm-web docs/slice-6-readable-excerpts.md` supersedes "prompts stay on-device": the wrap may store and POST bounded excerpts — the last user ask and tool-result bytes already on the request — so `/usage` can show the ask and teammates can reuse paid-for work. Still fail the PR for:

- Full multi-turn transcripts, system/developer messages, provider API keys, or wrap tokens leaving the machine.
- Invented identified-savings or `shared_context_savings_usd`. Savings come from stored prior `cost_usd` or token deltas observed at the intercept (labeled estimates), never a rate table.
- Surfacing prompts as surveillance. Excerpts are receipt data.
- `helm proxy` / `helm wrap` is the live intercept surface. Easy install must keep working (curl / Homebrew, no flow disruption).
- Cursor cloud VMs do not wrap the model path.
- CLI-only users are a first-class surface.

## How to evaluate a CLI change

1. Does this help Observe (traffic into Helm), Diagnose (workload / overlap / model metadata), or Optimize?
2. Does install stay one terminal step?
3. Are we sending bounded excerpts / fingerprints / cost / model / path — never whole transcripts or credentials?
4. Did we invent a savings dollar?
5. Does every savings number trace to a stored measurement, paired with a shipped-work signal?
