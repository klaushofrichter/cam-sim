// Replaced by the fault registry in Task 7.
export interface FaultSpec {
  name: string;
  count?: number;
  ms?: number;
  cmds?: string[];
  rspCode?: number;
}
