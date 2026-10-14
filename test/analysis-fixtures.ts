import type { ModelConfig } from '../src/analysis-model.ts';
export function simulatedModel(contextWindow = 1000000, respond?: (body: Record<string, unknown>, signal: AbortSignal | null | undefined) => Promise<Response>): ModelConfig {
  return { provider: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', apiKey: 'simulation-only-key', transport: async (url, init) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro', context_window: contextWindow, max_output_tokens: Math.floor(contextWindow / 3) }] }));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (respond) return respond(body, init?.signal);
    return modelResponse(body);
  } };
}
export function modelResponse(body: Record<string, unknown>, options: { status?: string; usage?: unknown; text?: string } = {}) {
  const input = JSON.parse(String(body.input));
  const ref = input.records[0]?.id ?? input.summaries[0]?.report.observations[0]?.id;
  const report = { observations: [{ text: input.stage === 'synthesis' ? '依据分段结果复盘；无法判断动机或未记录时点。' : '依据记录复盘；无法判断动机或未记录时点。', kind: 'inference', timing: 'unknown', refs: [ref] }], evidence: [], improvements: [], nextChecks: [] };
  return new Response(JSON.stringify({ status: options.status ?? 'completed', usage: options.usage, output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: options.text ?? JSON.stringify(report) }] }] }));
}
