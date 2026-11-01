# benchforge: research + design draft

## Decisions (from grill)
- Target: SV-UVM only, must compile on VCS + Questa. Verilator local only for lint.
- Interface: CLI core, thin web UI. Single user, project files on disk (git friendly). No DB/auth.
- Run env: ETX remote desktop; browser runs ON server. Bottleneck = keystroke -> pixel stream, not HTTP.
- Draw UX: A (outline tree) + B (click-to-add / click-port-to-wire). Auto layout only. No drag/resize.
- Scale: 100+ boxes -> collapse/expand + subtree layout caching mandatory.
- Class types: built-in UVM set + user-defined types (config: base class, ports, render style).
- Regen: generated base files overwritten; user code in separate extension files / protected regions.
- TLM: analysis port->imp/export/fifo, seq_item_port<->export, blocking put/get/transport, TLM-2.0 sockets, auto export chaining across hierarchy.
- Objects: rand/randc, bit/logic [N:0], int, enum, arrays (dyn/queue/fixed), nested struct/object, constraints + covergroup stubs, macros-or-manual do_copy/compare/print switch.
- DUT: user port list first; SV header parse optional (phase 2). Reverse code->diagram: later.
- Export: SVG of arch diagram; bit-field SVG for transactions.

## Stack recommendation
TypeScript on Node, bundled with esbuild to one dir/file (vendored, offline).
- One language for core, CLI, layout (elkjs) and bit-field SVG (npm `bit-field`).
- Templates: Eta/Nunjucks-style, one template per class type, user-overridable dir.
- Model: YAML/JSON file (source of truth), JSON-schema validated.
- Web: tiny server (node http) + vanilla TS/Preact, SVG render. Same core runs in browser.
- Phase 2 parser: slang (C++ binary) or tree-sitter-verilog.

## ETX-aware UI rules
- Zero animation, no hover effects, no transitions, no blur/shadow/gradient; flat colors.
- Repaint only changed DOM nodes; no full-SVG replace on each keystroke.
- Keyboard-first; mouse is optional. Debounce layout ~50ms; layout in Web Worker.
- Prefer terminal TUI mode for lightest stream (later option).
- Verify with spike: measure ETX frame cost with real session.

## Layout plan
- elkjs layered, hierarchyHandling=INCLUDE_CHILDREN, ports on node sides (analysis ports east, imps west).
- Per-type render style: container (env/agent) vs leaf (scoreboard) vs port-bearing.
- Cache layout per collapsed subtree; collapsed box = leaf with port summary.
- Risk: ELK time on 100-300 nodes with cross-hierarchy edges. Spike benchmark first.

## Prior art (borrow ideas)
uvm-tb-gen, uvmgen, OpenTitan uvmdvgen, DVCon GUI template builder. All flat (no nested diagram, weak TLM).

## Resolved (round 4)
- UVM 1.2 + 1.1d: template switch per version (1.1d lacks some 1.2 APIs; macros/TLM names differ slightly).
- No company guidelines/base classes: ship neutral defaults, templates overridable later.
- Custom types: YAML config only (extends, shape leaf|container, ports, optional template path).
- Scaffold scope v1: components + base test + top tb/interface/DUT. No sequences/vseqr.
- Infographic: 1 transaction per SVG.
- UI: TUI + web UI, both over same core -> keep core UI-agnostic (model, layout, codegen as library).

## Resolved (round 5)
- Diagram depth: show max 3 levels at once; deeper = user picks a component to drill into (focus view). Also bounds layout cost.
- Sim compat: user runs generated code on VCS/Questa and reports errors; keep templates per UVM version easy to patch.

## Next
- Spike: elkjs 100+ box nested layout timing (spike/).

## Spike findings (round 5)
- ELK ~50ms @126 nodes, ~70ms @210 (Node, Mac).
- INCLUDE_CHILDREN = one global direction, ratio 8.7:1 (bad). SEPARATE_CHILDREN + per-container options (layered DOWN, MULTI_EDGE wrapping, aspectRatio 1.6; agents RIGHT) = ratio 0.69, clean nested, orthogonal TLM routes.
- Rule: TLM crossing a hierarchy boundary goes through a port on the boundary box (matches UVM export chaining). Layout per container, cacheable per subtree.
- Files: spike/render.mjs -> out.svg, feel.html (ETX feel test).
