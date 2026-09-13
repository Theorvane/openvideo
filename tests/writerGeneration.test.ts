import { describe, expect, it, vi } from 'vitest';

import { extractWriterJson, requestAgentRouterWriter, requestGeminiWriter } from '../src/shared/writerGeneration';
import { WRITER_RESPONSE_JSON_SCHEMA, type WriterDraft, type WriterRequest } from '../src/shared/writerWorkflow';

const request: WriterRequest = {
  mode: 'content_to_script', sourceText: 'A short product brief.', language: 'Vietnamese',
  audience: 'Creators', tone: 'Clear', targetDurationSeconds: 30
};
const draft: WriterDraft = {
  title: 'Creator tool', screenplay: 'A creator opens the tool.', characters: [],
  styleBible: { palette: [], lighting: '', cameraGrammar: '', texture: '', forbiddenChanges: [] },
  scenes: [{
    title: 'Open', objective: 'Introduce the tool.', setting: 'Studio', timeOfDay: 'Day', characterNames: [], continuityNotes: '',
    shots: [{ durationSeconds: 8, framing: 'Medium', cameraMotion: 'Static', action: 'The tool opens.', dialogue: '', audioCues: [], negativePrompt: '' }]
  }]
};

describe('Gemini Writer generation', () => {
  const promptsRequest: WriterRequest = {
    ...request,
    stage: 'prompts',
    approvedContext: [
      { stage: 'concept', content: 'Approved concept' },
      { stage: 'screenplay', content: 'Approved screenplay' },
      { stage: 'breakdown', content: 'Approved scene budgets' }
    ]
  };

  it('extracts a complete object from a JSON fence or short model preamble', () => {
    expect(extractWriterJson('Here is the requested JSON:\n```json\n{"title":"ok"}\n```\n')).toBe('{"title":"ok"}');
    expect(extractWriterJson('{"title":"brace } in string"} trailing text')).toBe('{"title":"brace } in string"}');
    expect(extractWriterJson('{"title":"unfinished"')).toBeNull();
  });

  it('ignores thought parts when a visible JSON part is present', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candidates: [{
      content: { parts: [{ text: 'internal thought', thought: true }, { text: JSON.stringify(draft) }] },
      finishReason: 'STOP'
    }] }), { status: 200 }));

    await expect(requestGeminiWriter({
      apiKey: 'test-key', modelId: 'gemini-3.1-flash-lite', request: promptsRequest, fetchImpl
    })).resolves.toMatchObject({ title: draft.title });
  });

  it('uses JSON mode without the deeply nested response schema at video prompts', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        generationConfig: Record<string, unknown>;
        contents: { parts: { text: string }[] }[];
      };
      expect(body.generationConfig).toEqual({ responseMimeType: 'application/json' });
      expect(body.contents[0]?.parts[0]?.text).toContain('REQUIRED PRODUCTION JSON SHAPE');
      expect(body.contents[0]?.parts[0]?.text).toContain(JSON.stringify(WRITER_RESPONSE_JSON_SCHEMA));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }] }), { status: 200 });
    });

    await expect(requestGeminiWriter({
      apiKey: 'test-key', modelId: 'gemini-3.1-flash-lite', request: promptsRequest, fetchImpl
    })).resolves.toMatchObject({ screenplay: 'Approved screenplay' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still rejects invalid production JSON without silently saving it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ ...draft, scenes: [] }) }] } }]
    }), { status: 200 }));

    await expect(requestGeminiWriter({
      apiKey: 'test-key', modelId: 'gemini-3.1-flash-lite', request: promptsRequest, fetchImpl
    })).rejects.toThrow('invalid project draft');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a truncated response instead of the misleading invalid JSON error', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candidates: [{
      content: { parts: [{ text: '{"title":"cut off' }] }, finishReason: 'MAX_TOKENS'
    }] }), { status: 200 }));

    await expect(requestGeminiWriter({
      apiKey: 'test-key', modelId: 'gemini-3.1-flash-lite', request: promptsRequest, fetchImpl
    })).rejects.toThrow(/truncated before valid JSON.*MAX_TOKENS/);
  });

  it('does not expose a prompt echoed by a stage-4 HTTP 400 or retry automatically', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Invalid argument: private approved screenplay and test-key' }
    }), { status: 400 }));

    await expect(requestGeminiWriter({
      apiKey: 'test-key', modelId: 'gemini-3.1-flash-lite', request: promptsRequest, fetchImpl
    })).rejects.toThrow('The approved stages are unchanged');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    try {
      await requestGeminiWriter({
        apiKey: 'test-key', modelId: 'gemini-3.1-flash-lite', request: promptsRequest, fetchImpl
      });
    } catch (error) {
      expect(String(error)).not.toContain('private approved screenplay');
      expect(String(error)).not.toContain('test-key');
    }
  });

  it('sends structured output through a header-only API key and parses the draft', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/gemini-3.1-pro-preview:generateContent');
      expect(String(url)).not.toContain('secret-key');
      expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key');
      const body = JSON.parse(String(init?.body)) as { generationConfig?: Record<string, unknown>; contents?: unknown[] };
      expect(body.generationConfig?.responseMimeType).toBe('application/json');
      expect(body.generationConfig?.responseJsonSchema).toBeDefined();
      expect(body.contents).toHaveLength(1);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }] }), { status: 200 });
    });
    await expect(requestGeminiWriter({ apiKey: 'secret-key', modelId: 'gemini-3.1-pro-preview', request, fetchImpl })).resolves.toEqual(draft);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed on invalid JSON and structurally incomplete output', async () => {
    const response = (text: string) => async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    await expect(requestGeminiWriter({ apiKey: 'key', modelId: 'gemini-3.1-flash-lite', request, fetchImpl: response('{') })).rejects.toThrow('invalid JSON');
    await expect(requestGeminiWriter({ apiKey: 'key', modelId: 'gemini-3.1-flash-lite', request, fetchImpl: response('{}') })).rejects.toThrow('at title: must be text');
  });

  it('reports a safe field path for semantic mismatches without echoing generated content', async () => {
    const privateTitle = 'private unreleased campaign';
    const mismatched = {
      ...draft,
      title: privateTitle,
      scenes: [{ ...draft.scenes[0]!, characterNames: ['Narrator'] }]
    };
    const fetchImpl = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(mismatched) }] } }]
    }), { status: 200 });
    try {
      await requestGeminiWriter({ apiKey: 'key', modelId: 'gemini-3.1-flash-lite', request, fetchImpl });
      throw new Error('Expected the mismatched draft to fail.');
    } catch (error) {
      expect(String(error)).toContain('scenes[0].characterNames[0]');
      expect(String(error)).not.toContain(privateTitle);
      expect(String(error)).not.toContain('Narrator');
    }
  });

  it('does not echo the API key in provider errors', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Bad request for never-log-me' } }), { status: 400 });
    await expect(requestGeminiWriter({ apiKey: 'never-log-me', modelId: 'gemini-3.1-pro-preview', request, fetchImpl })).rejects.toThrow('Bad request for [REDACTED]');
    try {
      await requestGeminiWriter({ apiKey: 'never-log-me', modelId: 'gemini-3.1-pro-preview', request, fetchImpl });
    } catch (error) {
      expect(String(error)).not.toContain('never-log-me');
    }
  });

  it('aborts a stalled provider request instead of leaving Writer busy forever', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

    await expect(requestGeminiWriter({
      apiKey: 'key',
      modelId: 'gemini-3.1-flash-lite',
      request,
      fetchImpl,
      timeoutMs: 10
    })).rejects.toThrow('did not finish within 1 seconds');
    expect((fetchImpl.mock.calls[0]?.[1]?.signal as AbortSignal | undefined)?.aborted).toBe(true);
  });
});

describe('AgentRouter Writer generation', () => {
  it('keeps the shared/mobile seam disabled while desktop owns the HTTP credential boundary', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(requestAgentRouterWriter({
      apiKey: 'router-secret', modelId: 'agentrouter/gpt-5.6-sol', request, fetchImpl
    })).rejects.toThrow('currently available in OpenScene desktop');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
