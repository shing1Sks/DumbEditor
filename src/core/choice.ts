export interface ChoiceRequest {
  question: string;
  options: string[];
  allowCustom: boolean;
}

export type RequestChoice = (request: ChoiceRequest) => Promise<string | null>;
