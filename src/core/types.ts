export type Dir = 'in' | 'out';
// boundary: written by the tool to forward a connection across a container; removed with its last connection
// ptype: the class the port is parameterized with (TLM-1 transaction, TLM-2 payload); omitted = the default for the kind
export interface PortDef { name: string; kind: string; dir: Dir; ptype?: string; boundary?: boolean }
export interface TypeDef {
  extends?: string;
  shape?: 'leaf' | 'container';
  focal?: boolean;
  ports?: RawPort[];
  template?: string;
}
// dir is optional in files: the kind decides it
export type RawPort = Omit<PortDef, 'dir'> & { dir?: Dir };
export interface ModelNode { name: string; type: string; ports?: RawPort[]; children?: ModelNode[] }
export interface Conn { from: string; to: string }
export interface DutPort { name: string; dir: 'in' | 'out' | 'inout'; width?: number }
export interface Dut {
  name: string;
  clock?: { name?: string; period_ns?: number };
  reset?: { name?: string; active?: 'low' | 'high' };
  ports?: DutPort[];
}
export interface Model {
  project: string;
  uvm?: '1.2' | '1.1d';
  types?: Record<string, TypeDef>;
  dut?: Dut;
  // uvm_object classes that ports may be parameterized with; <project>_item always exists
  objects?: { name: string; extends?: 'uvm_object' | 'uvm_sequence_item' }[];
  root: ModelNode;
  connections?: Conn[];
}
// A type with extends fully applied.
export interface ResolvedType { name: string; shape: 'leaf' | 'container'; focal: boolean; ports: PortDef[]; template?: string }
