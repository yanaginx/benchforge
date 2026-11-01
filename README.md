# benchforge

Generate a UVM testbench scaffold from a small YAML model. Edit the model from the
command line or in a local web UI that draws the testbench as a diagram.

- Targets UVM 1.2 and 1.1d (`uvm:` in the model).
- Model is plain YAML, checked against a JSON schema plus extra rules (port kinds,
  parameter types, hop-by-hop wiring across containers).
- Generated code is split in `gen/` (regenerated every run) and `user/` (yours, never overwritten).
- Everything runs locally. The only dependencies are `ajv`, `elkjs` and `yaml`.

## Requirements

Node 22.6 or newer (it runs the TypeScript sources directly).

```
npm install
```

## Quick start

```
node --experimental-strip-types src/cli.ts ui examples/axi.yaml
```

Open http://127.0.0.1:8765. Click a box to edit it, drag from an output port to a
highlighted input port to wire it, use the toolbar for levels, zoom and undo/redo.
The name in the top bar opens a menu to open another file, save a copy or download
the YAML. Every edit is written straight to the model file.

Generate the scaffold from the UI (Generate button) or the command line:

```
node --experimental-strip-types src/cli.ts gen examples/axi.yaml --dry-run
node --experimental-strip-types src/cli.ts gen examples/axi.yaml --out axi_tb
```

## Model

```yaml
project: axi_vip
uvm: "1.2"
dut: { name: axi_slave, clock: { name: aclk, period_ns: 10 }, reset: { name: aresetn, active: low } }
root:
  name: tb
  type: env
  children:
    - name: m_agent
      type: agent
      children:
        - { name: sqr, type: sequencer }
        - { name: drv, type: driver }
        - { name: mon, type: monitor }
connections:
  - { from: "tb.m_agent.drv:seq_item_port", to: "tb.m_agent.sqr:seq_item_export" }
```

Built-in types: component, env, agent, sequencer, driver, monitor, scoreboard, subscriber.
Port kinds decide direction (`analysis_port`, `analysis_imp`, `seq_item_port`, TLM-2
sockets, and so on). A port with no `ptype` carries `uvm_object`; sockets carry
`uvm_tlm_generic_payload`; `seq_item_*` ports carry `<project>_item`. Declare more
classes under `objects:`. A wire joins two ports only when kind and type match.
Connections across containers are made hop by hop through container ports; the
`wire` command and the UI add those ports for you.

More models in `examples/` (`axi`, `play`, `tlm2`, and `stress` for fan-in/fan-out).

## Command line

```
check <model>                          validate
tree <model>                           outline with ports and connections
svg <model> [-o f.svg] [--root path] [--depth n]
add | rm | set | object | port | wire | unwire | apply     edit (validated before the file is touched)
gen <model> [--out dir] [--dry-run] [--force]
ui <model> [--port 8765] [--out dir]
```

Add `--json` for machine output. Exit codes: 0 ok, 1 validation or edit error, 2 usage.
Run `node --experimental-strip-types src/cli.ts` with no arguments for the full list.

## Diagram

Placement uses elkjs; the wires are routed by a small orthogonal A* router written
for this project (few corners, no shared lanes, no wire through a box, bridges where
wires must cross, dots where they join). Containers of containers flow left to right.
Notes on the design are in `docs/`.

## Tests

```
npm test
```

## Status

Early. Generated SystemVerilog has not been compiled on VCS or Questa yet, and the
UVM 1.1d differences and TLM-2 socket signatures are unverified against a simulator.
