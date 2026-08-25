---
name: Operational visual language
description: Visual hierarchy and colour-use rules for the Solar SCADA operator interface.
---

Build the SCADA interface from neutral graphite or slate surfaces with a single restrained solar accent for primary emphasis. Reserve green, amber, and red for source-backed operational state, validation, warning, fault, offline, or unavailable evidence—not for decorative KPI variation.

**Why:** Operators need a calm, premium control surface where a coloured element signals a meaningful condition instead of competing with surrounding telemetry.

**How to apply:** Use neutral cards, subtle elevation, concise typography, and low-contrast structural dividers by default. Apply the solar accent to selected navigation, primary actions, and focused data. Do not add gradients, glows, or per-card colours unless they communicate a specific state.

For dashboard overviews, order the scan path as site and operational health, concise primary KPIs, then the power-flow and diagnostic surfaces. Keep the status bands compact so the main readings fit in the initial workspace without suppressing provenance.

**Why:** Operators should confirm scope and evidence quality before acting on the values, while avoiding a tall stack of decorative chrome ahead of the plant's key performance readings.

**How to apply:** At laptop and tablet widths, favor full-width fleet and diagnostic surfaces over narrow side-by-side panels. Reserve dense multi-column KPI rows and split operational panels for content areas that are genuinely wide enough.

For weather workspaces, low-saturation icon tints may distinguish metric categories, but values and surfaces remain neutral and the tints must never imply an operational state.

**Why:** Weather variables benefit from quick visual scanning, while the real weather source, freshness, cached state, and unavailable state must remain semantically unambiguous.

**How to apply:** Keep all weather-provider evidence separate from configured-coordinate provenance. When no provider response exists, label weather source, observation time, and freshness as unavailable while continuing to show location provenance independently.