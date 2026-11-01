# benchforge: Web UI + TUI layout draft

Both UIs are thin views over the same core (model, layout, codegen). The model file (YAML) is the source of truth.
ETX rules apply: flat colors, no animation or hover effects, patch only changed DOM, keyboard first.

## Shared concepts
- **Focus**: one selected node (tree row = diagram box). Selection is the only cursor.
- **View root**: the node currently drilled into. Diagram shows view root + 2 more levels (3 total). Deeper boxes render as dashed `[+N]` leaves.
- **Modes**: `tree` (edit structure), `wire` (pick TLM source port, then target port), `obj` (transaction/config editor).
- **Dirty marker**: model saved on every commit to disk (git friendly), `*` in the status bar until written.

## Keymap (same in web and TUI)
| Key | Action |
|---|---|
| `j`/`k` or arrows | move selection in tree |
| `h`/`l` | collapse / expand (or pop / push view root with `H`/`L`) |
| `a` | add child to selected (type picker opens) |
| `A` | add sibling after selected |
| `Tab` / `Shift+Tab` | nest under previous sibling / un-nest |
| `t` | change class type of selected |
| `r` | rename |
| `d` | delete (confirm with `y`) |
| `Enter` | drill into selected (becomes view root) |
| `Backspace` | go up one view root |
| `w` | start wiring from selected; port picker opens |
| `W` | list/delete connections of selected |
| `o` | open object editor (transactions/configs list) |
| `g` | generate scaffold (dry run first, shows file list) |
| `e` | export SVG of current view |
| `/` | filter tree by name or type |
| `?` | help overlay |
| `:` | command line (`:gen`, `:export`, `:uvm 1.1d`, `:save`) |
| `u` / `Ctrl+r` | undo / redo |

## Web UI

```
+---------------------------------------------------------------------------------+
| benchforge  project: axi_vip.yaml          uvm 1.2 v   [gen] [export svg]   saved|
+-------------------+-------------------------------------------+-----------------+
| OUTLINE           | DIAGRAM  top > env0 > agent_a   (3 levels)| INSPECTOR       |
|                   |                                           |                 |
| v top [env]       |  +-- ENV0 [env] ------------------------+ | name: agent_a   |
|   v env0 [env]    |  | +-- AGENT_A [agent] ----+            | | type: agent  v  |
| > v agent_a [agt] |  | | sqr -> drv    mon [] --+---> sb ---+ | | active: yes     |
|       sqr         |  | +-----------------------+   [sb]     | |                 |
|       drv         |  +--------------------------------------+ | PORTS           |
|       mon         |                                           |  ap  analysis   |
|     sb [sb]       |  [+14] agent_b                            |   -> sb.imp0    |
|   > env1 [env] +9 |                                           |                 |
|                   |                                           | CONFIG          |
|                   |                                           |  cfg_t  agent_cfg|
+-------------------+-------------------------------------------+-----------------+
| mode: tree | sel: agent_a | 41 boxes, 3 visible levels | layout 38ms | ? help   |
+---------------------------------------------------------------------------------+
```

Panes:
- **Outline (left, 22%)**: the editing surface. Indented tree, type tag per row, `+N` for collapsed descendants. `a`, `Tab`, `t` act here. Selection is mirrored in the diagram with a thick accent border.
- **Diagram (center)**: read-only SVG from ELK. Click a box selects it; click a port in `wire` mode picks it. No drag, no resize. Breadcrumb at the top is clickable to pop the view root.
- **Inspector (right, 24%)**: fields of the selected node: name, type, type-specific options, ports list with existing connections, config object ref. Edits commit on `Enter`.
- **Status bar**: mode, selection, counts, last layout ms, hint of next key.

### Overlays (modal, centered, flat)
- **Type picker**: filterable list of built-in and user-defined types, one-line description each. Type to filter, `Enter` to pick.
- **Wire dialog**: step 1 pick source port (list of ports on selection), step 2 pick target (filterable list of compatible ports in the whole model, shown as `path.port [kind]`). Incompatible pairs are not listed. Shows the chain of auto-generated export ports that will be created across boundaries before confirm.
- **Generate dialog**: dry-run file list with `new / overwrite / skip (user-owned)` tags, then `Enter` to write.

### Object editor (separate screen, `o`)
```
+---------------------------------------------------------------------------------+
| OBJECTS            | axi_txn [transaction]                  | PREVIEW (bit-field)  |
|  axi_txn  [txn]    |  # name     type        w   mods       |  +--------+------+ |
|  axi_cfg  [cfg]    |  1 addr     bit [31:0]  32  rand       |  | addr   | len  | |
|  err_cfg  [cfg]    |  2 len      bit [7:0]   8   rand       |  | 31..0  | 7..0 | |
|                    |  3 burst    enum burst_e 2  rand       |  +--------+------+ |
|                    |  4 data     bit [7:0] q  -  rand       |                      |
|                    |  CONSTRAINTS  c_len { len inside..}   |  [export svg]        |
|                    |  COVER       cg_burst (stub)           |                      |
+--------------------+----------------------------------------+----------------------+
| Tab next cell | Enter edit | a add field | d delete | m macros/manual: macros      |
+---------------------------------------------------------------------------------+
```
- Table is a grid you navigate with arrows; `Tab` moves to the next cell; `a` adds a row below.
- Preview is a bit-field SVG, regenerated on field commit (debounced 50ms). One transaction per SVG.
- `m` toggles `uvm_field` macros vs manual `do_copy/compare/print` for the whole object.

## TUI

Same three zones, tighter. Diagram is a coarse box-drawing view of the current view root only (children one level down), since full nested ASCII does not fit.

```
+- benchforge  axi_vip.yaml  uvm1.2 -------------------------------- saved -+
| OUTLINE                         | VIEW  top > env0                          |
| v top [env]                     |  +-- env0 [env] -----------------------+  |
|   v env0 [env]                  |  | [agent_a]--ap-->[sb]                |  |
| >   agent_a [agent] +3          |  | [agent_b]--ap-->[sb]                |  |
|     agent_b [agent] +3          |  | [env1 +9]                           |  |
|     sb [scoreboard]             |  +-------------------------------------+  |
|     env1 [env] +9               |                                           |
|                                 | SEL agent_a [agent]                       |
|                                 |  ports: ap(analysis) -> sb.imp0           |
|                                 |  cfg: agent_cfg                           |
+---------------------------------+-------------------------------------------+
| tree | agent_a | 41 boxes | a add  t type  w wire  Enter drill  ? help        |
+-----------------------------------------------------------------------------+
```
- Left: outline (always full tree, collapsible). Right top: coarse view of the view root's direct children and TLM links. Right bottom: inspector as plain text.
- Full SVG is a web or export concern; TUI can run `:export` to write the same SVG file.
- Object editor in TUI is the same grid, bit-field preview as a one-line text ruler: `[31:addr:0][39:len:32]...`.
- Rendering rule: redraw only changed rows, no color animation, 16-color palette.

## CLI map (for reference, same core)
- `benchforge init <name>`: create project YAML.
- `benchforge tree`: print outline.
- `benchforge add|rm|set|wire ...`: edit model non-interactively (for scripts).
- `benchforge gen [--uvm 1.2|1.1d] [--dry-run]`: write scaffold.
- `benchforge svg [--root path] [--depth 3]`: architecture SVG.
- `benchforge obj add|set ...`, `benchforge obj svg <txn>`: object editing and bit-field SVG.
- `benchforge ui` (web) and `benchforge tui`.

## Decisions to confirm
1. Outline owns editing; diagram is read-only except for selection and port picking in `wire` mode.
2. Wiring uses a filtered picker list, not free-hand line drawing.
3. Web and TUI share the keymap above.
4. TUI diagram is coarse (one level of children), not full nested ASCII.
