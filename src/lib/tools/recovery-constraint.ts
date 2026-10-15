/** A runner may prevent a repeated attempt; this can never authorize a tool. */
export type ToolRecoveryConstraint = Readonly<{
  reason: string;
  output: Readonly<{ executed: false; [key: string]: unknown }>;
}>;
