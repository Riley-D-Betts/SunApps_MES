# SunApps MES — Project Overview

*What it is, why it matters, and the value it delivers to Ida Milk.*

---

## The problem it solves

Every week, Ida Milk's plant moves millions of pounds of milk through a long chain of equipment — intake bays, raw silos, the separator, blend tanks, UHT processing, surge tanks, and the fillers. Each of those steps changes the product: raw milk becomes cream and skim, components get blended into recipes, finished goods get packaged.

For the business to know **what it has, what it costs, and where it went**, every one of those physical changes needs to be recorded in our ERP (NetSuite) as an inventory transaction. But historically, **none of this in‑plant production was tracked in NetSuite at all.** Milk came in the door and finished goods came out the other end, but everything that happened in between — the separation, the blending, the processing, the losses — was a blind spot in our financial and inventory system. There was no work order, no costed transformation, no measured waste; just a gap that had to be backed into after the fact.

**The SunApps MES service closes that gap entirely.** It watches the plant directly and records each production stage in NetSuite as it happens — turning what was an invisible middle of the process into a continuous, costed, traceable record. This is visibility the business simply did not have before.

---

## How it works, in plain terms

The plant's control system (AVEVA Historian) already records thousands of sensor readings every few seconds — tank levels, flow totals, temperatures, what product is in each silo, which line is running. That data describes everything happening on the floor; it just isn't connected to our accounting.

This service sits in the middle:

1. **It listens.** Every few seconds it reads the live plant data — tank levels, flow meters, equipment status.
2. **It understands.** It recognizes the start and end of each production run ("a batch"), figures out what product it is, and measures exactly how much milk moved.
3. **It records.** It posts the matching transactions into NetSuite automatically — creating work orders, issuing ingredients, completing finished goods, and adjusting for waste — all tagged with lot numbers and storage locations.

The result: NetSuite reflects what actually happened in the plant, in near‑real time, with a complete and traceable paper trail.

---

## What the business gets out of it

**Inventory that exists where there was nothing.**
In‑plant production now appears in NetSuite in near‑real time — a category of inventory movement the ERP previously had no record of at all. Decisions about production, shipping, and purchasing can finally be made on numbers that reflect what's actually happening on the floor *right now*.

**Product costing that was never possible before.**
Because every transformation — milk into cream and skim, components into blends, blends into finished goods — is now captured with its real measured quantities, the true cost of each product can be calculated for the first time. This feeds directly into margins, pricing, and financial reporting that previously had to estimate or ignore the in‑plant steps.

**Waste and shrinkage made visible.**
The system measures how much milk was *issued* into a stage versus how much actually *arrived* at the next one. The difference is waste — and now it's measured, quantified, and recorded automatically at every stage instead of being completely invisible. That's a direct, ongoing lever on yield and loss that the business had no way to see before.

**Full traceability for food safety and audits.**
Every batch is tied to lot numbers and bins through the whole chain. If a question ever arises about a specific lot — a recall, a quality investigation, an audit — the trail already exists in the system, automatically.

**No new manual burden.**
Capturing this level of detail by hand would have meant people keying in thousands of production transactions a week — which is exactly why it was never done before. The service delivers that detail automatically, so the business gets the visibility without taking on the labor or the human error that would otherwise come with it.

**Confidence and control.**
A built‑in "dry run" mode and a full historical‑replay capability mean changes can be validated against real past production before they ever touch the ERP. The system is designed to be safe to evolve.

---

## Why this is strategically important

This isn't a reporting dashboard bolted on after the fact — it's the **connective tissue between the plant floor and the financials.** It turns the raw signal the plant already produces into trustworthy operational and financial truth, continuously and automatically.

That foundation compounds:

- **It scales.** As volume grows, the cost of keeping inventory accurate doesn't grow with it — the automation absorbs it.
- **It's the basis for analytics.** With clean, batch‑level, lot‑traced data flowing in, the business can answer yield, waste, and efficiency questions it simply couldn't before.
- **It de‑risks the operation.** Fewer manual errors, faster close, and an always‑ready audit trail reduce both financial and regulatory risk.

In short: the plant runs on physics; the business runs on NetSuite. For the entire middle of our process, those two were never connected. **SunApps MES is what finally connects them — automatically, every few seconds.**

---

## Status

The service is built, deployed, and running in production, integrated with the live plant historian and NetSuite. It currently covers the core production stages — bulk intake, separation, blend tanks, surge tanks / finished goods — along with automated waste tracking, inventory reconciliation, and cost revaluation, plus an analytics API for batch history and inventory‑adjustment insight.
