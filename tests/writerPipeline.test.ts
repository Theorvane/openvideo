import { describe, expect, it, vi } from 'vitest';
import { createEmptyAiProjectDocument, parseAiProjectDocument } from '../src/shared/aiProjectDomain';
import { WRITER_STAGES, canOpenWriterStage, parseWriterPipelineState, type WriterStageArtifact } from '../src/shared/writerStages';
import { approvedWriterShots, applyWriterPipeline, applyWriterStyleLock, artifactFromWriterDraft, buildWriterStageRequest, editWriterPromptShot, parseWriterPromptText, pipelineBaseRequest, pipelineMatchesBrief, saveWriterArtifact, startWriterPipeline } from '../src/shared/writerPipeline';
import { applyWriterDraft, compileWriterPrompt, parseWriterRequest, validateWriterResponse, writerResponseSchema, writerSystemPrompt, type WriterDraft, type WriterRequest } from '../src/shared/writerWorkflow';
import { requestGeminiWriter } from '../src/shared/writerGeneration';
import { chainContinuationFrame, nextApprovedWriterShotId } from '../src/shared/generationReview';

const brief: WriterRequest = { mode: 'idea_to_script', sourceText: 'The first social network was yelling.', language: 'English', audience: 'Adults', tone: 'Deadpan satire', targetDurationSeconds: 16, videoStyle: 'cinematic-narrative', emotionalGoal: 'entertain' };
const artifact = (stage: WriterStageArtifact['stage'], content = `Complete ${stage} document`): WriterStageArtifact => ({ stage, title: 'The Stone Age Scroll', content, modelId: 'gemini-3.1-flash-lite', approved: false });
const production: WriterDraft = {
  title: 'The Stone Age Scroll', screenplay: 'Provider accidentally abbreviated this.',
  characters: [{ name: 'Grog', invariantDescription: 'Red hide, chipped front tooth.' }],
  styleBible: { palette: ['ochre'], lighting: 'Morning sun', cameraGrammar: 'Locked wides', texture: 'Stone', forbiddenChanges: ['Red hide'] },
  scenes: [{ title: 'S1 / SC1 The post', objective: 'A public boast backfires.', setting: 'Cave mouth', timeOfDay: 'Morning', characterNames: ['Grog'], continuityNotes: 'Red hide throughout.', shots: [
    { durationSeconds: 8, framing: 'Wide', cameraMotion: 'Locked', action: 'Grog in a red hide at the cave mouth shouts about his hunt.', dialogue: 'A mammoth!', audioCues: ['Echo'], negativePrompt: 'No phones' },
    { durationSeconds: 8, framing: 'Close', cameraMotion: 'Locked', action: 'Grog in a red hide at the cave mouth reveals a tiny mouse in his palm.', dialogue: '', audioCues: ['Squeak'], negativePrompt: 'No phones' }
  ] }]
};
function approvedWriting() {
  let state = startWriterPipeline(brief);
  for (const stage of ['concept', 'screenplay', 'breakdown'] as const) state = saveWriterArtifact(state, artifact(stage), true);
  return state;
}
function approvedAll() { return saveWriterArtifact(approvedWriting(), artifactFromWriterDraft('prompts', production, 'test-model'), true); }

describe('manual Writer pipeline', () => {
  it('reapplies the approved Style Bible exactly once at the generation boundary', () => {
    const first = applyWriterStyleLock('Grog raises the stone.\nAvoid: phones', production.styleBible);
    expect(first).toContain('[OPENSCENE_STYLE_LOCK]');
    expect(first).toContain('Palette: ochre');
    expect(first).toContain('Forbidden changes: Red hide');
    const revised = applyWriterStyleLock(`${first}\nMake the action faster.`, { ...production.styleBible, lighting: 'Blue moonlight' });
    expect(revised.match(/\[OPENSCENE_STYLE_LOCK\]/g)).toHaveLength(1);
    expect(revised).toContain('Make the action faster.');
    expect(revised).toContain('Lighting: Blue moonlight');
    expect(revised).not.toContain('Lighting: Morning sun');
  });

  it('hands off only approved, explicitly imported shots with identity, dialogue and continuity intact', () => {
    const empty = createEmptyAiProjectDocument();
    expect(approvedWriterShots(empty)).toEqual([]);
    expect(approvedWriterShots({ ...empty, writerPipeline: approvedAll() })).toEqual([]);
    const imported = applyWriterPipeline(empty, approvedAll(), '2026-09-05T00:00:00.000Z', 'handoff');
    if (!imported.ok) throw new Error(imported.message);
    const shots = approvedWriterShots(imported.document);
    expect(shots).toHaveLength(2);
    expect(shots.map((shot) => shot.id)).toEqual(imported.document.shots.map((shot) => shot.id));
    expect(shots[0]?.durationSeconds).toBe(8);
    expect(shots[0]?.prompt).toContain('Character Grog: Red hide');
    expect(shots[0]?.prompt).toContain('Spoken lines: A mammoth!');
    expect(shots[0]?.prompt).toContain('Continuity: Red hide throughout.');
    expect(shots[0]?.prompt).toContain('Avoid: No phones');
    const revised = saveWriterArtifact(imported.document.writerPipeline!, artifact('concept', 'New idea'), true);
    expect(approvedWriterShots({ ...imported.document, writerPipeline: revised })).toEqual([]);
    expect(imported.document.generations).toEqual([]);
  });

  it('replaces the next real Writer shot start frame only from an approved preceding candidate', () => {
    const imported = applyWriterPipeline(createEmptyAiProjectDocument(), approvedAll(), '2026-09-05T00:00:00.000Z', 'handoff');
    if (!imported.ok) throw new Error(imported.message);
    const [firstShot, secondShot] = imported.document.shots;
    if (!firstShot || !secondShot) throw new Error('fixture shots missing');
    const approvedSource = {
      ...imported.document,
      shots: imported.document.shots.map((shot) => shot.id === firstShot.id ? { ...shot, generationIds: ['generation-approved'] } : shot),
      generations: [{
        id: 'generation-approved', shotId: firstShot.id, providerId: 'gemini_veo', modelId: 'veo-3.1',
        capability: 'text_to_video' as const, status: 'completed' as const, prompt: 'First shot', referenceAssetIds: [],
        outputAssetIds: ['asset-video'], createdAt: '2026-09-05T00:01:00.000Z', updatedAt: '2026-09-05T00:02:00.000Z',
        review: {
          decision: 'approved' as const,
          continuity: { identity: 'pass' as const, wardrobeProps: 'pass' as const, settingPalette: 'pass' as const, motionDirection: 'pass' as const, boundaryMatch: 'pass' as const },
          notes: '', reviewedAt: '2026-09-05T00:03:00.000Z'
        }
      }]
    };

    expect(nextApprovedWriterShotId(approvedSource, firstShot.id)).toBe(secondShot.id);
    expect(nextApprovedWriterShotId(approvedSource, secondShot.id)).toBeNull();
    expect(chainContinuationFrame(approvedSource, {
      sourceGenerationId: 'generation-approved', sourceAssetId: 'asset-wrong', targetShotId: secondShot.id,
      frameAssetId: 'asset-frame', referenceId: 'reference-frame', label: 'Boundary'
    })).toMatchObject({ ok: false, reason: 'The selected source video is not an output of this approved candidate.' });

    const chained = chainContinuationFrame(approvedSource, {
      sourceGenerationId: 'generation-approved', sourceAssetId: 'asset-video', targetShotId: secondShot.id,
      frameAssetId: 'asset-frame', referenceId: 'reference-frame', label: 'Boundary'
    });
    expect(chained.ok).toBe(true);
    if (!chained.ok) return;
    expect(chained.document.referenceAssets).toContainEqual({
      id: 'reference-frame', assetId: 'asset-frame', role: 'start_frame', label: 'Boundary'
    });
    expect(chained.document.shots.find((shot) => shot.id === secondShot.id)?.referenceAssetIds).toEqual(['reference-frame']);

    const replacement = chainContinuationFrame({
      ...chained.document,
      generations: chained.document.generations.map((generation) => generation.id === 'generation-approved'
        ? { ...generation, outputAssetIds: [...generation.outputAssetIds, 'asset-video-2'] }
        : generation)
    }, {
      sourceGenerationId: 'generation-approved', sourceAssetId: 'asset-video-2', targetShotId: secondShot.id,
      frameAssetId: 'asset-frame-2', referenceId: 'reference-frame-2', label: 'Replacement boundary'
    });
    expect(replacement.ok).toBe(true);
    if (replacement.ok) {
      expect(replacement.document.shots.find((shot) => shot.id === secondShot.id)?.referenceAssetIds).toEqual(['reference-frame-2']);
      expect(replacement.document.referenceAssets.map((reference) => reference.id)).toEqual(['reference-frame', 'reference-frame-2']);
    }
  });
  it('edits the actual production prompt without stripping typed whitespace or touching other shots', () => {
    const content = JSON.stringify(production);
    const edited = editWriterPromptShot(content, 0, 0, { action: 'New action ', dialogue: 'Line with trailing space ' });
    expect(parseWriterPromptText(edited)?.scenes[0]?.shots[0]?.action).toBe('New action ');
    expect(parseWriterPromptText(edited)?.scenes[0]?.shots[1]).toEqual(production.scenes[0]?.shots[1]);
    const cleared = editWriterPromptShot(edited, 0, 0, { action: '' });
    expect(parseWriterPromptText(cleared)?.scenes[0]?.shots[0]?.action).toBe('');
    expect(() => saveWriterArtifact(approvedWriting(), artifact('prompts', cleared), true)).toThrow('action');
    expect(() => editWriterPromptShot(content, 40, 0, {})).toThrow('selected shot');
  });
  it('starts at concept and refuses to skip a missing or unapproved predecessor', () => {
    const state = startWriterPipeline(brief);
    expect(canOpenWriterStage(state, 'concept')).toBe(true);
    expect(() => buildWriterStageRequest(state, 'screenplay')).toThrow('preceding');
    const draft = saveWriterArtifact(state, artifact('concept'), false);
    expect(canOpenWriterStage(draft, 'screenplay')).toBe(false);
    expect(() => saveWriterArtifact(draft, artifact('breakdown'), true)).toThrow('preceding');
    const approved = saveWriterArtifact(draft, artifact('concept'), true);
    expect(canOpenWriterStage(approved, 'screenplay')).toBe(true);
    expect(approved.artifacts).toHaveLength(1);
  });

  it('persists progress with the project, including options, without changing production graphs', () => {
    const state = approvedWriting();
    const document = { ...createEmptyAiProjectDocument(), writerPipeline: state };
    const reopened = parseAiProjectDocument(JSON.parse(JSON.stringify(document)))!;
    expect(reopened).toEqual(document);
    expect(pipelineBaseRequest(reopened.writerPipeline)).toEqual(brief);
    expect(reopened.scripts).toEqual([]);
    expect(reopened.shots).toEqual([]);
    expect(parseAiProjectDocument(createEmptyAiProjectDocument())).not.toBeNull();
  });

  it('passes every approved document, including manual edits, into the next request', () => {
    let state = approvedWriting();
    state = saveWriterArtifact(state, artifact('screenplay', 'Manually revised full script and dialogue.'), true);
    state = saveWriterArtifact(state, artifact('breakdown'), true);
    const request = buildWriterStageRequest(state, 'prompts', 'Use an awkward silent beat.');
    expect(request.approvedContext?.map((a) => a.stage)).toEqual(['concept', 'screenplay', 'breakdown']);
    expect(request.approvedContext?.[1]?.content).toContain('Manually revised');
    expect(compileWriterPrompt(request)).toContain('Use an awkward silent beat.');
    expect(compileWriterPrompt(request)).toContain('Manually revised');
    expect(compileWriterPrompt(request)).not.toContain('BRIEF (source data)');
    expect(compileWriterPrompt(request)).not.toContain(brief.sourceText);
    const styledRequest = { ...request, customVideoStyle: 'Traditional 2D Cel Animation with hand-painted cels.' };
    expect(compileWriterPrompt(styledRequest)).toContain('CUSTOM VIDEO STYLE DIRECTION: Traditional 2D Cel Animation');
  });

  it('regenerates from the saved current stage, not just the original brief', () => {
    const state = approvedWriting();
    const request = buildWriterStageRequest(state, 'screenplay', 'Improve the callback', true);
    expect(request.currentStageText).toBe('Complete screenplay document');
    expect(compileWriterPrompt(request)).toContain('CURRENT STAGE DRAFT TO REVISE');
    expect(parseWriterRequest(request)).toEqual(request);
  });

  it('retains downstream text but revokes approvals after an upstream edit', () => {
    const state = approvedAll();
    const changed = saveWriterArtifact(state, artifact('concept', 'New ending and stakes'), true);
    expect(changed.artifacts.map((a) => a.approved)).toEqual([true, false, false, false]);
    expect(changed.artifacts[3]?.content).toBe(state.artifacts[3]?.content);
    expect(canOpenWriterStage(changed, 'prompts')).toBe(false);
    expect(applyWriterPipeline(createEmptyAiProjectDocument(), changed, new Date().toISOString(), 'x').ok).toBe(false);
  });

  it('revoking approval without editing also invalidates dependent approvals', () => {
    const state = approvedAll();
    const changed = saveWriterArtifact(state, state.artifacts[0]!, false);
    expect(changed.artifacts.every((a) => !a.approved)).toBe(true);
    expect(parseWriterPipelineState(changed)).not.toBeNull();
  });

  it('detects brief/style/duration/source changes and restores credential-free settings', () => {
    const state = startWriterPipeline(brief);
    expect(pipelineMatchesBrief(state, brief)).toBe(true);
    for (const change of [{ targetDurationSeconds: 20 }, { tone: 'Serious' }, { language: 'Vietnamese' }, { sourceText: 'New idea' }, { emotionalGoal: 'inspire' as const }]) {
      expect(pipelineMatchesBrief(state, { ...brief, ...change })).toBe(false);
    }
    expect(pipelineBaseRequest({ ...state, requestJson: '{' })).toBeNull();
    expect(() => startWriterPipeline({ ...brief, targetDurationSeconds: 4.5 })).toThrow();
    expect(parseWriterRequest({ ...brief, apiKey: 'do-not-store' })).toBeNull();
  });

  it.each(['concept', 'screenplay', 'breakdown'] as const)('uses a writing-only schema for %s, never a production graph', (stage) => {
    const request = buildWriterStageRequest(approvedWriting(), stage);
    expect(writerResponseSchema(request)).toMatchObject({ required: ['title', 'screenplay'] });
    expect(writerSystemPrompt(request)).toContain('exactly the requested stage');
    expect(compileWriterPrompt(request)).toContain(`CURRENT STAGE: ${stage}`);
    const response = validateWriterResponse({ title: 'Treatment', screenplay: 'Full stage text' }, request);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.value.scenes).toEqual([]);
    expect(applyWriterDraft({ document: createEmptyAiProjectDocument(), request, draft: response.value, createdAt: new Date().toISOString(), idPrefix: 'bad' }).ok).toBe(false);
    expect(validateWriterResponse(production, request).ok).toBe(false);
  });

  it('rejects missing, duplicate, out-of-order and unexpected upstream inputs at IPC validation', () => {
    const request = buildWriterStageRequest(approvedWriting(), 'prompts');
    expect(parseWriterRequest(request)).not.toBeNull();
    expect(parseWriterRequest({ ...request, approvedContext: [] })).toBeNull();
    expect(parseWriterRequest({ ...request, approvedContext: [...request.approvedContext!].reverse() })).toBeNull();
    expect(parseWriterRequest({ ...request, stage: 'auto' })).toBeNull();
    expect(parseWriterRequest({ ...brief, approvedContext: [] })).toBeNull();
    expect(parseWriterRequest({ ...brief, currentStageText: 'bad' })).toBeNull();
    expect(parseWriterRequest({ ...request, approvedContext: request.approvedContext!.map((a) => ({ ...a, apiKey: 'bad' })) })).toBeNull();
  });

  it('rejects duplicate artifacts, oversized text and impossible approved states on load', () => {
    const state = approvedWriting();
    expect(parseWriterPipelineState({ ...state, artifacts: [state.artifacts[0], state.artifacts[0]] })).toBeNull();
    expect(parseWriterPipelineState({ ...state, artifacts: [{ ...artifact('prompts'), approved: true }] })).toBeNull();
    expect(parseWriterPipelineState({ ...state, artifacts: [artifact('concept', 'a'.repeat(200_001))] })).toBeNull();
    expect(parseWriterPipelineState({ ...state, secret: 'bad' })).toBeNull();
  });

  it('saves incomplete prompt JSON as draft but blocks approval and application', () => {
    const state = approvedWriting();
    const bad = artifact('prompts', '{');
    const saved = saveWriterArtifact(state, bad, false);
    expect(saved.artifacts[3]?.content).toBe('{');
    expect(() => saveWriterArtifact(saved, bad, true)).toThrow('JSON');
    expect(applyWriterPipeline(createEmptyAiProjectDocument(), saved, new Date().toISOString(), 'bad').ok).toBe(false);
  });

  it('blocks approval on total-duration mismatch rather than silently stretching the film', () => {
    const state = { ...approvedWriting(), requestJson: JSON.stringify({ ...brief, targetDurationSeconds: 420 }) };
    const draft = artifactFromWriterDraft('prompts', production, 'test');
    expect(saveWriterArtifact(state, draft, false).artifacts[3]?.approved).toBe(false);
    expect(() => saveWriterArtifact(state, draft, true)).toThrow('Shot total is 16s');
  });

  it('accepts a shot total within ten seconds of the requested duration', () => {
    const within = { ...approvedWriting(), requestJson: JSON.stringify({ ...brief, targetDurationSeconds: 26 }) };
    expect(saveWriterArtifact(within, artifactFromWriterDraft('prompts', production, 'test'), true).artifacts[3]?.approved).toBe(true);
    const outside = { ...approvedWriting(), requestJson: JSON.stringify({ ...brief, targetDurationSeconds: 27 }) };
    expect(() => saveWriterArtifact(outside, artifactFromWriterDraft('prompts', production, 'test'), true)).toThrow('within ±10s');
  });

  it('requires exact canonical character names when approving production prompts', () => {
    const changed = { ...production, scenes: [{ ...production.scenes[0]!, characterNames: ['grog'] }] };
    expect(() => saveWriterArtifact(approvedWriting(), artifactFromWriterDraft('prompts', changed, 'test'), true)).toThrow('canonical');
  });

  it('applies only on an explicit final action, preserves screenplay and prevents duplicate import after reopening', () => {
    const state = approvedAll();
    const result = applyWriterPipeline(createEmptyAiProjectDocument(), state, '2026-09-05T00:00:00.000Z', 'writer-test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.scripts[0]?.screenplay).toBe('Complete screenplay document');
    expect(result.document.shots).toHaveLength(2);
    expect(result.document.generations).toEqual([]);
    const reopened = parseAiProjectDocument(JSON.parse(JSON.stringify(result.document)))!;
    expect(reopened.writerPipeline?.appliedScriptId).toBe(result.scriptId);
    expect(applyWriterPipeline(reopened, reopened.writerPipeline!, '2026-09-05T00:00:00.000Z', 'duplicate').ok).toBe(false);
    const changed = saveWriterArtifact(reopened.writerPipeline!, artifact('screenplay', 'Changed ending'), true);
    expect(changed.appliedScriptId).toBeUndefined();
  });

  it('preserves existing script ancestry for staged rewrite', () => {
    const old = applyWriterPipeline(createEmptyAiProjectDocument(), approvedAll(), '2026-09-05T00:00:00.000Z', 'old');
    if (!old.ok) throw new Error(old.message);
    const request = { ...brief, mode: 'rewrite' as const, parentScriptId: old.scriptId, currentScreenplay: old.document.scripts[0]!.screenplay };
    const state = { ...approvedAll(), requestJson: JSON.stringify(parseWriterRequest(request)) };
    const result = applyWriterPipeline(old.document, state, '2026-09-05T01:00:00.000Z', 'new');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.scripts.find((s) => s.id === 'new-script')?.parentVersionId).toBe(old.scriptId);
    expect(result.document.scripts.find((s) => s.id === old.scriptId)?.status).toBe('superseded');
  });

  it('does not overwrite older character profiles or silently reuse a changed identity', () => {
    const old = applyWriterPipeline(createEmptyAiProjectDocument(), approvedAll(), '2026-09-05T00:00:00.000Z', 'before');
    if (!old.ok) throw new Error(old.message);
    const draft = { ...production, characters: [{ name: 'Grog', invariantDescription: 'Blue hide, missing front tooth.' }] };
    const state = saveWriterArtifact(approvedWriting(), artifactFromWriterDraft('prompts', draft, 'test'), true);
    const result = applyWriterPipeline(old.document, state, '2026-09-05T01:00:00.000Z', 'after');
    if (!result.ok) throw new Error(result.message);
    const oldId = old.document.scenes[0]!.characterIds[0];
    const newId = result.document.scenes.find((s) => s.scriptVersionId === result.scriptId)!.characterIds[0];
    expect(newId).not.toBe(oldId);
    expect(result.document.characters.find((c) => c.id === oldId)?.invariantDescription).toContain('Red hide');
    expect(result.document.characters.find((c) => c.id === newId)?.invariantDescription).toContain('Blue hide');
  });

  it('makes exactly one mocked Gemini call for a concept; no automatic screenplay or video request', async () => {
    const request = buildWriterStageRequest(startWriterPipeline(brief), 'concept');
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.responseJsonSchema.required).toEqual(['title', 'screenplay']);
      expect(body.contents[0].parts[0].text).toContain('CURRENT STAGE: concept');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Treatment', screenplay: 'Full developed premise' }) }] } }] }));
    });
    const result = await requestGeminiWriter({ apiKey: 'fake-test-key', modelId: 'gemini-3.1-flash-lite', request, fetchImpl });
    expect(result.scenes).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
