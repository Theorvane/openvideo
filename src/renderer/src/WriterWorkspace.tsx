import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AiProjectDocument } from '../../shared/aiProjectDomain';
import {
  WRITER_MODEL_IDS, WRITER_VIDEO_STYLES, WRITER_VIDEO_STYLE_LABELS, WRITER_EMOTIONAL_GOALS,
  type WriterMode, type WriterRequest, type WriterVideoStyle, type WriterEmotionalGoal
} from '../../shared/writerWorkflow';
import { pipelineBaseRequest, pipelineMatchesBrief } from '../../shared/writerPipeline';
import { WRITER_STAGES, WRITER_STAGE_LABELS, WRITER_STAGE_CHECKLISTS, canOpenWriterStage } from '../../shared/writerStages';
import { createUseWriterPipeline } from '../../shared/useWriterPipeline';
import { getLlmProvider } from '../../shared/llmProviders';
import { useAiDomainModel } from './AiDomainModelContext';
import { useLlmModel } from './LlmProviderContext';
import { DomainModelPicker } from './DomainModelPicker';
import { Button, StatusCard } from './ui';
import { WriterPromptEditor } from './WriterPromptEditor';
const useWriterPipeline = createUseWriterPipeline({ useEffect, useRef, useState });

export function WriterWorkspace({ document, onSave }: {
  readonly document: AiProjectDocument;
  readonly onSave: (document: AiProjectDocument) => Promise<boolean>;
}): ReactElement {
  const { selectedModel } = useAiDomainModel();
  const { credentialStatus } = useLlmModel();
  // Preserve the disconnected-model guard: the workspace must remain readable.
  let model: ReturnType<typeof selectedModel> | undefined;
  try { model = selectedModel('writer'); } catch { /* Settings provides the recovery route. */ }
  const initial = pipelineBaseRequest(document.writerPipeline);
  const [mode, setMode] = useState<WriterMode>(initial?.mode ?? 'idea_to_script');
  const [sourceText, setSourceText] = useState(initial?.sourceText ?? '');
  const [language, setLanguage] = useState(initial?.language ?? 'Vietnamese');
  const [audience, setAudience] = useState(initial?.audience ?? 'General audience');
  const [tone, setTone] = useState(initial?.tone ?? 'Cinematic and engaging');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(initial?.targetDurationSeconds ?? 60);
  const [videoStyle, setVideoStyle] = useState<WriterVideoStyle | ''>(initial?.videoStyle ?? '');
  const [customVideoStyle, setCustomVideoStyle] = useState(initial?.customVideoStyle ?? '');
  const [emotionalGoal, setEmotionalGoal] = useState<WriterEmotionalGoal | ''>(initial?.emotionalGoal ?? '');
  const [parentScriptId, setParentScriptId] = useState(initial?.parentScriptId ?? '');
  const [notes, setNotes] = useState('');
  const flow = useWriterPipeline(document, onSave);
  const selectedParent = document.scripts.find((script) => script.id === parentScriptId);
  const provider = model ? getLlmProvider(model.providerId) : undefined;
  const connected = provider?.credentialKey !== undefined && credentialStatus[provider.credentialKey] === true;
  const base: WriterRequest = {
    mode, sourceText: sourceText.trim(), language: language.trim(), audience: audience.trim(), tone: tone.trim(), targetDurationSeconds,
    ...(videoStyle ? { videoStyle } : {}), ...(customVideoStyle.trim() ? { customVideoStyle: customVideoStyle.trim() } : {}), ...(emotionalGoal ? { emotionalGoal } : {}),
    ...(mode === 'rewrite' && selectedParent ? { parentScriptId: selectedParent.id, currentScreenplay: selectedParent.screenplay } : {})
  };
  const briefChanged = flow.state !== undefined && !pipelineMatchesBrief(flow.state, base);
  const canGenerate = !flow.busy && !flow.dirty && connected && model !== undefined && sourceText.trim().length > 0 &&
    language.trim().length > 0 && audience.trim().length > 0 && tone.trim().length > 0 &&
    Number.isSafeInteger(targetDurationSeconds) && targetDurationSeconds >= 4 && targetDurationSeconds <= 7200 &&
    (mode !== 'rewrite' || selectedParent !== undefined) && (!briefChanged || flow.stage === 'concept');
  const generate = (): void => {
    const chosen = model;
    if (!chosen || !(WRITER_MODEL_IDS as readonly string[]).includes(chosen.id)) return;
    void flow.generate(base, chosen.id, notes, async (request) => {
      const response = await window.videoTool.generateWriterDraft({ modelId: chosen.id as (typeof WRITER_MODEL_IDS)[number], request });
      if (!response.ok) throw new Error(response.error.message);
      return response.value;
    });
  };
  const nextStage = WRITER_STAGES[WRITER_STAGES.indexOf(flow.stage) + 1];
  const approved = flow.artifact?.approved === true && !flow.dirty && !briefChanged;
  const approvalBlockedReason = flow.busy
    ? 'Writer is still working. Wait for the draft to finish.'
    : briefChanged
      ? 'The creative brief changed. Return to Develop idea and generate the revised concept before approving this stage.'
      : approved
        ? 'This stage is already approved. Continue to the next stage when ready.'
        : undefined;
  return (
    <section className="ai-workspace writer-workspace" aria-labelledby="writer-workspace-title">
      <header className="ai-workspace__header">
        <div>
          <p className="section-kicker">{model?.providerLabel ?? 'Writer'} · manual creative workflow</p>
          <h2 id="writer-workspace-title">Writer Studio</h2>
          <p className="ai-workspace__subtitle">Develop the idea, write the story, plan scenes, then create prompts. You edit and approve every step.</p>
        </div>
        <DomainModelPicker domain="writer" ariaLabel="Writer model" />
      </header>
      <nav className="writer-stage-nav" aria-label="Writer stages">
        {WRITER_STAGES.map((stage) => (
          <Button key={stage} {...(flow.stage === stage ? { variant: 'primary' as const } : {})}
            disabled={flow.busy || flow.dirty || !canOpenWriterStage(flow.state ?? { artifacts: [] }, stage) || (briefChanged && stage !== 'concept')}
            onClick={() => { flow.chooseStage(stage); setNotes(''); }}>
            {WRITER_STAGE_LABELS[stage]}{flow.state?.artifacts.some((a) => a.stage === stage && a.approved) && !briefChanged ? ' ✓' : ''}
          </Button>
        ))}
      </nav>
      <div className="ai-workspace__grid">
        <div className="ai-workspace__form-panel studio-form">
          <fieldset className="writer-brief-fields" disabled={flow.busy || flow.dirty}>
            <legend>Creative brief</legend>
            <label className="studio-field"><span className="studio-field__label">Source</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as WriterMode)}>
                <option value="idea_to_script">Short idea</option><option value="content_to_script">Existing content</option><option value="rewrite">Rewrite a saved script</option>
              </select>
            </label>
            {mode === 'rewrite' && <label className="studio-field"><span className="studio-field__label">Script version</span>
              <select value={parentScriptId} onChange={(e) => setParentScriptId(e.target.value)}><option value="">Choose a version</option>
                {document.scripts.slice().reverse().map((script) => <option key={script.id} value={script.id}>{script.title}</option>)}
              </select></label>}
            <label className="studio-field"><span className="studio-field__label">{mode === 'rewrite' ? 'Requested changes' : 'Idea / source content'}</span>
              <textarea rows={7} value={sourceText} onChange={(e) => setSourceText(e.target.value)} placeholder="A short idea is enough. Add must-keep details and anything to avoid." />
            </label>
            <div className="writer-workspace__row">
              <label className="studio-field"><span className="studio-field__label">Language</span><input value={language} onChange={(e) => setLanguage(e.target.value)} /></label>
              <label className="studio-field"><span className="studio-field__label">Duration (seconds)</span><input type="number" min={4} max={7200} value={targetDurationSeconds} onChange={(e) => setTargetDurationSeconds(Number(e.target.value))} /></label>
            </div>
            <label className="studio-field"><span className="studio-field__label">Audience</span><input value={audience} onChange={(e) => setAudience(e.target.value)} /></label>
            <label className="studio-field"><span className="studio-field__label">Tone</span><input value={tone} onChange={(e) => setTone(e.target.value)} /></label>
            <label className="studio-field"><span className="studio-field__label">Video style</span><select value={videoStyle} onChange={(e) => setVideoStyle(e.target.value as WriterVideoStyle | '')}>
              <option value="">Auto</option>{WRITER_VIDEO_STYLES.map((style) => <option key={style} value={style}>{WRITER_VIDEO_STYLE_LABELS[style]}</option>)}
            </select></label>
            <label className="studio-field"><span className="studio-field__label">Custom video style (optional)</span>
              <input value={customVideoStyle} maxLength={1000} onChange={(e) => setCustomVideoStyle(e.target.value)} placeholder="e.g. Traditional 2D Cel Animation with hand-drawn ink lines" />
            </label>
            <label className="studio-field"><span className="studio-field__label">Emotional goal</span><select value={emotionalGoal} onChange={(e) => setEmotionalGoal(e.target.value as WriterEmotionalGoal | '')}>
              <option value="">Auto</option>{WRITER_EMOTIONAL_GOALS.map((goal) => <option key={goal} value={goal}>{goal}</option>)}
            </select></label>
          </fieldset>
          {briefChanged && <StatusCard tone="warning">Brief changed. Return to step 1 and generate a revised concept. Saved downstream text is retained, but its approvals will be reset.</StatusCard>}
          <label className="studio-field"><span className="studio-field__label">Direction / revision notes for this stage</span>
            <textarea rows={4} disabled={flow.busy} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What should be stronger? Specify the hook, pacing, humor, emotional beat or constraints." />
          </label>
          {!connected && <StatusCard tone="warning">Connect a Writer model in Settings → Providers before generating.</StatusCard>}
          <p className="studio-reference__empty">Generate sends the brief, existing script (for rewrite), approved preceding documents and these notes to {model?.providerLabel ?? 'the selected provider'}. It may incur text-generation charges. No video is generated here.</p>
          <Button variant="primary" disabled={!canGenerate} onClick={generate}>{flow.busy ? 'Working…' : flow.artifact ? 'Regenerate this stage' : `Generate ${WRITER_STAGE_LABELS[flow.stage]}`}</Button>
          {flow.artifact && <p className="studio-reference__empty">Regeneration creates a replacement draft. Save any manual edits first; use revision notes to request changes.</p>}
          {flow.message && <StatusCard tone="neutral">{flow.message}</StatusCard>}
        </div>
        <div className="ai-workspace__results-panel writer-preview writer-stage-editor" aria-live="polite">
          <h3>{WRITER_STAGE_LABELS[flow.stage]} — {approved ? 'Approved' : flow.dirty ? 'Unsaved draft' : 'Review'}</h3>
          <details open><summary>Review checklist</summary><ul>{WRITER_STAGE_CHECKLISTS[flow.stage].map((item) => <li key={item}>{item}</li>)}</ul></details>
          {!flow.artifact ? <p>No draft for this stage yet. Generate only when you are ready.</p> : <>
            <label className="studio-field"><span className="studio-field__label">Title</span><input disabled={flow.busy} value={flow.artifact.title} onChange={(e) => flow.edit({ title: e.target.value })} /></label>
            {flow.stage === 'prompts' && <WriterPromptEditor content={flow.artifact.content} targetSeconds={targetDurationSeconds} disabled={flow.busy} onChange={(content) => flow.edit({ content })} />}
            <label className="studio-field"><span className="studio-field__label">{flow.stage === 'prompts' ? 'Advanced production JSON — bible, scenes and shots' : 'Full stage document — edit freely before approval'}</span>
              <textarea className="writer-stage-content" disabled={flow.busy} value={flow.artifact.content} onChange={(e) => flow.edit({ content: e.target.value })} spellCheck={flow.stage !== 'prompts'} />
            </label>
            {flow.stage === 'prompts' && <p>The approved screenplay is preserved when saving. Edit the screenplay in step 2, not inside this technical JSON.</p>}
            {approvalBlockedReason && <StatusCard tone={briefChanged ? 'warning' : 'neutral'}>{approvalBlockedReason}</StatusCard>}
            <div className="writer-preview__actions">
              {flow.dirty && <Button disabled={flow.busy} onClick={flow.discard}>Discard edits</Button>}
              <Button disabled={flow.busy || briefChanged} onClick={() => void flow.save(false)}>Save draft</Button>
              <Button variant="primary" title={approvalBlockedReason} aria-label={approvalBlockedReason ?? 'Approve and save this stage'} disabled={flow.busy || briefChanged || approved} onClick={() => void flow.save(true)}>
                {approved ? 'Stage already approved' : 'Approve & save this stage'}
              </Button>
            </div>
            {approved && nextStage && <Button variant="primary" disabled={flow.busy} onClick={() => { flow.chooseStage(nextStage); setNotes(''); }}>Continue to {WRITER_STAGE_LABELS[nextStage]}</Button>}
            {approved && flow.stage === 'prompts' && <Button variant="primary" disabled={flow.busy || flow.applied} onClick={() => void flow.apply()}>{flow.applied ? 'Production scenes saved' : 'Create production scenes (no video generation)'}</Button>}
          </>}
        </div>
      </div>
    </section>
  );
}
