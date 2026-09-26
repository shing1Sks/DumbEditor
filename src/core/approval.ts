export type ApprovalCategory = "model-switch" | "coding-harness" | "tool";

export interface ApprovalRequest {
  category: ApprovalCategory;
  title: string;
  description: string;
  model?: string;
  provider?: string;
  parameters?: Record<string, unknown>;
}

export type RequestApproval = (request: ApprovalRequest) => Promise<boolean>;
