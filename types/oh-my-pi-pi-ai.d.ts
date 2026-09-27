declare module "@oh-my-pi/pi-ai" {
  export function completeSimple(
    model: { readonly id: string; readonly provider: string },
    context: {
      systemPrompt?: string[];
      messages: Array<{ role: "user"; content: string; timestamp: number }>;
    },
    options?: {
      apiKey?: string | ((...args: never[]) => Promise<string | undefined>);
      maxTokens?: number;
      disableReasoning?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<{
    stopReason: string;
    errorMessage?: string;
    content: ReadonlyArray<{ type: string; text?: string }>;
  }>;
}
