# Web UI layout research (mouse-first, ETX-safe)

Scope: web UI is mouse-centric. Key-centric editing moves to the TUI (see ui-layout.md keymap).

## Findings (product docs, no formal usability studies)
- draw.io: three-panel shell. Shapes/library left, canvas center, format (inspector) panel right, toolbar on top. Its Sketch theme floats the inspector as a movable dialog. Has an outline/overview for large canvases that jumps the viewport on click.
  https://www.drawio.com/docs/manual/editor/panels/
- Sybase/SAP diagram editor: a hierarchical outline indexes every element and selecting a row jumps to it on the canvas. The properties view follows the selected element.
  https://infocenter.sybase.com/help/topic/com.sybase.infocenter.dc01622.0500/doc/html/kes1304460991582.html
- SAP design system: data that fits a tree belongs in a tree component, not a diagram. Offer context menus on shapes, connectors and canvas background.
  https://www.sap.com/design-system/btp/dna-design/components/diagrams/usage
- Node editors (Maya, Vuo): compatible ports are highlighted while connecting; Maya supports click source port then click target port. Mouse-only prototypes note drag is painful on trackpads and that connecting needs an obvious cancel.
  https://help.autodesk.com/cloudhelp/ENU/MayaCRE-Basics/files/GUID-C6E5588F-40A4-4B1E-9C02-A29DA9A4650F.htm
  https://doc.vuo.org/1.1.0/manual/working-on-the-canvas.xhtml
  https://github.com/forresto/dataflow-prototyping/issues/1
- draw.io layout docs: applying a layout recomputes from current state; results may differ on reapply. Our layout is deterministic and automatic, so no layout controls are needed.

## Decisions
1. Keep three panes: outline (left), diagram (center), inspector (right). Outline = structure editing and navigation; diagram = read-only picture plus selection and port clicks; inspector = every edit form for the selected node.
2. No drag and drop, no hover reveals. All controls are visible buttons or fields, so nothing repaints on mouse move.
3. Wiring is click-to-connect: click an output port square, compatible input squares get an accent box, click one to connect. Esc or a click on empty space cancels; banner says so. A form-based picker stays in the inspector for precision and for tiny ports.
4. Context menu (right click) on outline rows and diagram boxes. Items jump to the matching inspector control, so there is one editing path.
5. Large models: twisty expand/collapse in the outline, depth buttons (1-4), drill in by double click, clickable breadcrumb, zoom and fit buttons. Overview map deferred.
6. Performance: select = patch two class names and rebuild the small inspector; edit = one server call and one SVG innerHTML swap only when the SVG text changed; event delegation, no per-node listeners; no animation or transitions.
7. Delete uses a two-step button (no modal). Add child, rename, type, ports and wiring are inline forms.
