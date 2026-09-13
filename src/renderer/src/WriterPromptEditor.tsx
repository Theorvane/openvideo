import type { ReactElement } from 'react';
import { editWriterPromptShot, parseWriterPromptText } from '../../shared/writerPipeline';
import { writerDraftDurationMatchesTarget, writerDraftDurationSeconds, WRITER_DURATION_TOLERANCE_SECONDS } from '../../shared/writerWorkflow';

export function WriterPromptEditor({ content, targetSeconds, disabled, onChange }: {
  readonly content: string; readonly targetSeconds: number; readonly disabled: boolean; readonly onChange: (content: string) => void;
}): ReactElement {
  const draft = parseWriterPromptText(content);
  if (!draft) return <p>Fix the production JSON below to enable the shot editor. You can still save incomplete JSON as a draft.</p>;
  const seconds = writerDraftDurationSeconds(draft);
  const timingMatches = writerDraftDurationMatchesTarget(draft, targetSeconds);
  return <div className="writer-preview__scenes">
    <div className="writer-preview__summary"><strong>{draft.scenes.length} scenes · {draft.scenes.reduce((n, s) => n + s.shots.length, 0)} shots</strong>
      <span>{seconds}s / {targetSeconds}s requested{timingMatches ? (seconds === targetSeconds ? ' — timing matches' : ` — within ±${WRITER_DURATION_TOLERANCE_SECONDS}s tolerance`) : ' — adjust timing before approval'}</span></div>
    <details><summary>Character & style bible</summary>
      {draft.characters.map((character) => <p key={character.name}><strong>{character.name}</strong>: {character.invariantDescription}</p>)}
      <p>{draft.styleBible.palette.join(', ')} · {draft.styleBible.lighting} · {draft.styleBible.cameraGrammar} · {draft.styleBible.texture}</p>
      <p>{draft.styleBible.forbiddenChanges.join('; ')}</p>
      <small>Edit the bible and scene structure in the advanced JSON below.</small>
    </details>
    {draft.scenes.map((scene, si) => <details key={si} className="writer-preview__scene">
      <summary>{si + 1}. {scene.title} — {scene.shots.reduce((n, s) => n + s.durationSeconds, 0)}s</summary>
      <p>{scene.objective}</p><p>{scene.setting} · {scene.timeOfDay} · {scene.characterNames.join(', ')}</p><p>{scene.continuityNotes}</p>
      {scene.shots.map((shot, sh) => <fieldset key={sh} disabled={disabled} className="writer-shot-fields">
        <legend>Shot {si + 1}.{sh + 1}</legend>
        <label className="studio-field"><span className="studio-field__label">Seconds (1–120)</span>
          <input type="number" min={1} max={120} value={shot.durationSeconds} onChange={(e) => {
            const durationSeconds = Number(e.target.value);
            if (Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 120) onChange(editWriterPromptShot(content, si, sh, { durationSeconds }));
          }} /></label>
        {(['framing', 'cameraMotion', 'action', 'dialogue', 'negativePrompt'] as const).map((field) => <label key={field} className="studio-field">
          <span className="studio-field__label">{field === 'action' ? 'Video prompt / action' : field}</span>
          <textarea rows={field === 'action' ? 5 : 2} value={shot[field]} onChange={(e) => onChange(editWriterPromptShot(content, si, sh, { [field]: e.target.value }))} />
        </label>)}
        <label className="studio-field"><span className="studio-field__label">Audio cues (one per line)</span>
          <textarea rows={2} value={shot.audioCues.join('\n')} onChange={(e) => onChange(editWriterPromptShot(content, si, sh, { audioCues: e.target.value.split('\n') }))} /></label>
      </fieldset>)}
    </details>)}
  </div>;
}
