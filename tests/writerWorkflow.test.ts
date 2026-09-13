import { describe, expect, it } from 'vitest';

import { createEmptyAiProjectDocument, parseAiProjectDocument } from '../src/shared/aiProjectDomain';
import {
  WRITER_RESPONSE_JSON_SCHEMA,
  WRITER_VIDEO_STYLE_LABELS,
  applyWriterDraft,
  compileWriterPrompt,
  parseWriterDraft,
  parseWriterGenerationInput,
  parseWriterRequest,
  validateWriterDraft,
  writerDraftDurationMatchesTarget,
  writerDraftDurationSeconds,
  type WriterDraft,
  type WriterRequest
} from '../src/shared/writerWorkflow';

const request: WriterRequest = {
  mode: 'idea_to_script',
  sourceText: 'A baker delivers the last loaf during a storm.',
  language: 'Vietnamese',
  audience: 'Families',
  tone: 'Warm and cinematic',
  targetDurationSeconds: 12
};

const draft: WriterDraft = {
  title: 'The Last Loaf',
  screenplay: 'EXT. STREET — NIGHT\nA baker protects the last loaf from the rain.',
  characters: [{ name: 'Lan', invariantDescription: 'Vietnamese baker, red raincoat, canvas bag.' }],
  styleBible: {
    palette: ['amber', 'rain blue'],
    lighting: 'Warm shop light against cool rain.',
    cameraGrammar: 'Patient tracking shots.',
    texture: 'Fine film grain.',
    forbiddenChanges: ['Lan always wears the red raincoat.']
  },
  scenes: [{
    title: 'The delivery', objective: 'Lan reaches the customer.', setting: 'Rainy old street', timeOfDay: 'Night',
    characterNames: ['Lan'], continuityNotes: 'The bread stays dry inside the canvas bag.',
    shots: [
      { durationSeconds: 5, framing: 'Wide', cameraMotion: 'Track left', action: 'Lan runs through rain.', dialogue: '', audioCues: ['Rain'], negativePrompt: 'No wardrobe change.' },
      { durationSeconds: 7, framing: 'Close-up', cameraMotion: 'Slow push', action: 'Lan hands over the loaf.', dialogue: 'Still warm.', audioCues: ['Rain softens'], negativePrompt: 'No dry street.' }
    ]
  }]
};

describe('Writer workflow', () => {
  it('validates task-specific input and rejects rewrite requests without ancestry', () => {
    expect(parseWriterRequest(request)).toEqual(request);
    expect(parseWriterGenerationInput({ modelId: 'gemini-3.1-pro-preview', request })).toEqual({
      modelId: 'gemini-3.1-pro-preview', request
    });
    expect(parseWriterRequest({ ...request, mode: 'rewrite' })).toBeNull();
    expect(parseWriterRequest({ ...request, targetDurationSeconds: 0 })).toBeNull();
    expect(parseWriterGenerationInput({ modelId: 'grok-4', request })).toBeNull();
  });

  it('compiles source as delimited material and publishes a strict JSON schema', () => {
    const prompt = compileWriterPrompt(request);
    expect(prompt).toContain('<SOURCE_MATERIAL>');
    expect(prompt).toContain(request.sourceText);
    expect(prompt).toContain('Target finished duration: 12 seconds');
    expect(WRITER_RESPONSE_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(WRITER_RESPONSE_JSON_SCHEMA.required).toContain('scenes');
    expect(WRITER_RESPONSE_JSON_SCHEMA.properties.scenes.minItems).toBe(1);
    expect(WRITER_RESPONSE_JSON_SCHEMA.properties.scenes.maxItems).toBe(100);
    const shotSchema = WRITER_RESPONSE_JSON_SCHEMA.properties.scenes.items.properties.shots;
    expect(shotSchema.items.properties).toHaveProperty('framing');
    expect(shotSchema.items.properties).toHaveProperty('cameraMotion');
    expect(shotSchema.minItems).toBe(1);
    expect(shotSchema.maxItems).toBe(100);
    expect(shotSchema.items.properties.durationSeconds).toMatchObject({ type: 'integer', minimum: 1, maximum: 120 });
  });

  it('supports the Traditional 2D Cel Animation preset and bounded custom style direction', () => {
    const styled = {
      ...request,
      videoStyle: 'traditional-2d-cel-animation' as const,
      customVideoStyle: 'Hand-drawn ink contours, painted cel fills, and visible frame-by-frame timing.'
    };
    expect(WRITER_VIDEO_STYLE_LABELS[styled.videoStyle]).toBe('Traditional 2D Cel Animation');
    expect(parseWriterRequest(styled)).toEqual(styled);
    const prompt = compileWriterPrompt(styled);
    expect(prompt).toContain('TRADITIONAL 2D CEL ANIMATION');
    expect(prompt).toContain(styled.customVideoStyle);
    expect(parseWriterRequest({ ...styled, customVideoStyle: 'x'.repeat(1_001) })).toBeNull();
  });

  it('rejects partial drafts, duplicate characters, and unknown scene characters', () => {
    expect(parseWriterDraft(draft)).toEqual(draft);
    expect(parseWriterDraft({ ...draft, screenplay: '' })).toBeNull();
    expect(parseWriterDraft({ ...draft, characters: [...draft.characters, draft.characters[0]!] })).toBeNull();
    expect(parseWriterDraft({ ...draft, scenes: [{ ...draft.scenes[0]!, characterNames: ['Missing'] }] })).toBeNull();
    expect(parseWriterDraft({ ...draft, scenes: [{ ...draft.scenes[0]!, shots: [] }] })).toBeNull();
    expect(validateWriterDraft({ ...draft, scenes: [{ ...draft.scenes[0]!, characterNames: ['Missing'] }] })).toEqual({
      ok: false,
      issue: {
        path: 'scenes[0].characterNames[0]',
        code: 'unknown_character',
        message: 'must exactly match a name declared in characters.'
      }
    });
    expect(validateWriterDraft({
      ...draft,
      scenes: [{
        ...draft.scenes[0]!,
        shots: [{ ...draft.scenes[0]!.shots[0]!, durationSeconds: 121 }]
      }]
    })).toMatchObject({
      ok: false,
      issue: { path: 'scenes[0].shots[0].durationSeconds', code: 'invalid_number' }
    });
  });

  it('applies a reviewed draft as a valid script, scene, shot, character, and style graph', () => {
    const result = applyWriterDraft({
      document: createEmptyAiProjectDocument(), request, draft,
      createdAt: '2026-09-03T00:00:00.000Z', idPrefix: 'writer-first'
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scriptId).toBe('writer-first-script');
    expect(result.document.scripts[0]).toMatchObject({ sourceKind: 'idea', status: 'draft' });
    expect(result.document.scenes[0]?.shotIds).toEqual(['writer-first-scene-1-shot-1', 'writer-first-scene-1-shot-2']);
    expect(result.document.shots.map((shot) => shot.durationMs)).toEqual([5_000, 7_000]);
    expect(result.document.scenes[0]?.characterIds).toEqual(['writer-first-character-1']);
    expect(parseAiProjectDocument(result.document)).toEqual(result.document);
    expect(writerDraftDurationSeconds(draft)).toBe(12);
    expect(writerDraftDurationMatchesTarget(draft, 22)).toBe(true);
    expect(writerDraftDurationMatchesTarget(draft, 23)).toBe(false);
  });

  it('creates a child revision and supersedes its parent only in the applied document', () => {
    const first = applyWriterDraft({
      document: createEmptyAiProjectDocument(), request, draft,
      createdAt: '2026-09-03T00:00:00.000Z', idPrefix: 'writer-first'
    });
    if (!first.ok) throw new Error(first.message);
    const rewriteRequest: WriterRequest = {
      ...request,
      mode: 'rewrite',
      sourceText: 'Make the ending hopeful.',
      parentScriptId: first.scriptId,
      currentScreenplay: draft.screenplay
    };
    const rewritten = applyWriterDraft({
      document: first.document, request: rewriteRequest, draft: { ...draft, title: 'The Last Loaf — Hope' },
      createdAt: '2026-09-03T00:01:00.000Z', idPrefix: 'writer-second'
    });
    expect(first.document.scripts[0]?.status).toBe('draft');
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    expect(rewritten.document.scripts.map((script) => [script.id, script.status, script.parentVersionId])).toEqual([
      ['writer-first-script', 'superseded', undefined],
      ['writer-second-script', 'draft', 'writer-first-script']
    ]);
    expect(rewritten.document.characters).toHaveLength(1);
  });
});
