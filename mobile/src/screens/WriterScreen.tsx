import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { getDomainModels, isDomainModelAvailableOnRuntime } from '@openvideo/shared/aiDomainModels';
import { createEmptyAiProjectDocument, type AiProjectDocument } from '@openvideo/shared/aiProjectDomain';
import { requestWriter } from '@openvideo/shared/writerGeneration';
import { getLlmProvider } from '@openvideo/shared/llmProviders';
import { WRITER_MODEL_IDS, WRITER_VIDEO_STYLES, WRITER_VIDEO_STYLE_LABELS, WRITER_EMOTIONAL_GOALS, type WriterMode, type WriterRequest, type WriterVideoStyle, type WriterEmotionalGoal } from '@openvideo/shared/writerWorkflow';
import { pipelineBaseRequest, pipelineMatchesBrief } from '@openvideo/shared/writerPipeline';
import { WRITER_STAGES, WRITER_STAGE_LABELS, WRITER_STAGE_CHECKLISTS, canOpenWriterStage } from '@openvideo/shared/writerStages';
import { createUseWriterPipeline } from '@openvideo/shared/useWriterPipeline';
import { FormScreen } from '../components/FormScreen';
import { ModelSelect } from '../components/ModelSelect';
import { WriterPromptEditor } from '../components/WriterPromptEditor';
import { useRevealOnFocus } from '../components/KeyboardAwareScroll';
import { readSlot } from '../lib/credentials';
import { readProviderConnections } from '../lib/mediaProviders';
import { readProject, writeProject } from '../lib/projectStore';
import { MIN_TAP, press } from '../lib/touch';
import { theme } from '../lib/theme';
const useWriterPipeline = createUseWriterPipeline({ useEffect, useRef, useState });

type WriterScreenProps = {
  readonly topInset: number; readonly keyboardOffset: number;
  readonly projectId: string | null; readonly connectionsVersion: number;
};
export function WriterScreen(props: WriterScreenProps) {
  return <ProjectWriterScreen key={props.projectId ?? 'no-project'} {...props} />;
}
function ProjectWriterScreen({ topInset, keyboardOffset, projectId, connectionsVersion }: WriterScreenProps) {
  const catalog = getDomainModels('writer');
  const [modelId, setModelId] = useState(() => catalog[0]?.id ?? '');
  const [connected, setConnected] = useState<Readonly<Record<string, boolean>>>({});
  const project = projectId === null ? null : readProject(projectId);
  const initial = pipelineBaseRequest(project?.ai.writerPipeline);
  const [mode, setMode] = useState<WriterMode>(initial?.mode ?? 'idea_to_script');
  const [sourceText, setSourceText] = useState(initial?.sourceText ?? '');
  const [language, setLanguage] = useState(initial?.language ?? 'Vietnamese');
  const [audience, setAudience] = useState(initial?.audience ?? 'General audience');
  const [tone, setTone] = useState(initial?.tone ?? 'Cinematic and engaging');
  const [durationText, setDurationText] = useState(String(initial?.targetDurationSeconds ?? 60));
  const [parentScriptId, setParentScriptId] = useState(initial?.parentScriptId ?? '');
  const [videoStyle, setVideoStyle] = useState<WriterVideoStyle | ''>(initial?.videoStyle ?? '');
  const [customVideoStyle, setCustomVideoStyle] = useState(initial?.customVideoStyle ?? '');
  const [emotionalGoal, setEmotionalGoal] = useState<WriterEmotionalGoal | ''>(initial?.emotionalGoal ?? '');
  const [notes, setNotes] = useState('');
  const contentInput = useRef<TextInput>(null);
  const reveal = useRevealOnFocus();
  const persist = async (ai: AiProjectDocument): Promise<boolean> => {
    const latest = projectId === null ? null : readProject(projectId);
    if (!latest) return false;
    writeProject({ ...latest, ai });
    return true;
  };
  const flow = useWriterPipeline(project?.ai ?? createEmptyAiProjectDocument(), persist);
  const refresh = useCallback((): void => { void readProviderConnections().then(setConnected); }, []);
  useEffect(refresh, [connectionsVersion, refresh]);
  const model = catalog.find((entry) => entry.id === modelId) ?? catalog[0];
  const parent = project?.ai.scripts.find((script) => script.id === parentScriptId);
  const targetDurationSeconds = Number(durationText);
  const available = model !== undefined && isDomainModelAvailableOnRuntime(model, 'mobile');
  const base: WriterRequest = {
    mode, sourceText: sourceText.trim(), language: language.trim(), audience: audience.trim(), tone: tone.trim(), targetDurationSeconds,
    ...(videoStyle ? { videoStyle } : {}), ...(customVideoStyle.trim() ? { customVideoStyle: customVideoStyle.trim() } : {}), ...(emotionalGoal ? { emotionalGoal } : {}),
    ...(mode === 'rewrite' && parent ? { parentScriptId: parent.id, currentScreenplay: parent.screenplay } : {})
  };
  const briefChanged = flow.state !== undefined && !pipelineMatchesBrief(flow.state, base);
  const canGenerate = !flow.busy && !flow.dirty && project !== null && model !== undefined && available && connected[model.providerId] === true &&
    sourceText.trim().length > 0 && language.trim().length > 0 && audience.trim().length > 0 && tone.trim().length > 0 &&
    Number.isSafeInteger(targetDurationSeconds) && targetDurationSeconds >= 4 && targetDurationSeconds <= 7200 &&
    (mode !== 'rewrite' || parent !== undefined) && (!briefChanged || flow.stage === 'concept');
  const generate = (): void => {
    if (!model || !canGenerate) return;
    void flow.generate(base, model.id, notes, async (request) => {
      const provider = getLlmProvider(model.providerId);
      const apiKey = provider?.credentialKey === undefined ? null : await readSlot(provider.credentialKey);
      if (!apiKey) throw new Error('Connect the selected provider in Settings.');
      return requestWriter({ apiKey, modelId: model.id as (typeof WRITER_MODEL_IDS)[number], request });
    });
  };
  const nextStage = WRITER_STAGES[WRITER_STAGES.indexOf(flow.stage) + 1];
  const approved = flow.artifact?.approved === true && !flow.dirty && !briefChanged;
  const editable = !flow.busy && !flow.dirty;
  const action = (label: string, run: () => void, disabled = false) => (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={run} style={press([styles.secondary, disabled && styles.off])}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
  const field = (label: string, value: string, set: (value: string) => void, multiline = false) => <View>
    <Text style={styles.label}>{label}</Text>
    <TextInput editable={editable} value={value} onChangeText={set} multiline={multiline} style={[styles.input, multiline && styles.source]} />
  </View>;
  return (
    <FormScreen topInset={topInset} keyboardOffset={keyboardOffset}>
      <Text style={styles.h1}>Writer Studio</Text>
      <Text style={styles.sub}>Idea → screenplay → segments/scenes → video prompts. Edit and approve each step; nothing advances automatically.</Text>
      <ModelSelect domain="writer" selectedId={modelId} connected={connected} onSelect={(next) => setModelId(next.id)} onConnectionChange={refresh} />
      <View style={styles.row}>{WRITER_STAGES.map((stage) => <View key={stage}>{action(
        WRITER_STAGE_LABELS[stage] + (flow.state?.artifacts.some((a) => a.stage === stage && a.approved) && !briefChanged ? ' ✓' : ''),
        () => { flow.chooseStage(stage); setNotes(''); },
        flow.busy || flow.dirty || !canOpenWriterStage(flow.state ?? { artifacts: [] }, stage) || (briefChanged && stage !== 'concept')
      )}</View>)}</View>
      <Text style={styles.label}>Creative brief source</Text>
      <View style={styles.row}>{(['idea_to_script', 'content_to_script', 'rewrite'] as const).map((entry) => <View key={entry}>
        {action((mode === entry ? '✓ ' : '') + entry.replaceAll('_', ' '), () => setMode(entry), !editable)}
      </View>)}</View>
      {mode === 'rewrite' && <View><Text style={styles.label}>Script version</Text>
        {(project?.ai.scripts ?? []).slice().reverse().map((script) => <View key={script.id}>
          {action((script.id === parentScriptId ? '✓ ' : '') + script.title, () => setParentScriptId(script.id), !editable)}
        </View>)}
      </View>}
      {field('Idea / source / rewrite instructions', sourceText, setSourceText, true)}
      {field('Language', language, setLanguage)}{field('Seconds', durationText, setDurationText)}
      {field('Audience', audience, setAudience)}{field('Tone', tone, setTone)}
      <Text style={styles.label}>Video style</Text>
      <View style={styles.row}>{(['', ...WRITER_VIDEO_STYLES] as const).map((value) => <View key={value}>
        {action((videoStyle === value ? '✓ ' : '') + (value ? WRITER_VIDEO_STYLE_LABELS[value] : 'Auto'), () => setVideoStyle(value), !editable)}
      </View>)}</View>
      {field('Custom video style (optional)', customVideoStyle, setCustomVideoStyle)}
      <Text style={styles.label}>Emotional goal</Text>
      <View style={styles.row}>{(['', ...WRITER_EMOTIONAL_GOALS] as const).map((value) => <View key={value}>
        {action((emotionalGoal === value ? '✓ ' : '') + (value || 'Auto'), () => setEmotionalGoal(value), !editable)}
      </View>)}</View>
      {briefChanged && <Text style={styles.message}>Brief changed. Return to step 1 and generate a revised concept; dependent approvals will reset, with text retained.</Text>}
      <Text style={styles.label}>Revision notes for this stage</Text>
      <TextInput editable={!flow.busy} multiline value={notes} onChangeText={setNotes} style={[styles.input, styles.source]} />
      <Text style={styles.note}>Generate sends the brief, existing rewrite script, approved preceding documents and revision notes to the selected provider. Text-generation charges may apply. No video is generated.</Text>
      {!available && <Text style={styles.message}>{model?.unavailableReason ?? 'This model is unavailable on mobile.'}</Text>}
      <Pressable accessibilityRole="button" disabled={!canGenerate} onPress={generate} style={press([styles.primary, !canGenerate && styles.off])}>
        {flow.busy ? <ActivityIndicator color={theme.bg} /> : <Text style={styles.primaryText}>{flow.artifact ? 'Regenerate this stage' : 'Generate this stage'}</Text>}
      </Pressable>
      {!!flow.message && <Text style={styles.message}>{flow.message}</Text>}
      <View style={styles.preview}>
        <Text style={styles.previewTitle}>{WRITER_STAGE_LABELS[flow.stage]} — {approved ? 'Approved' : flow.dirty ? 'Unsaved draft' : 'Review'}</Text>
        {WRITER_STAGE_CHECKLISTS[flow.stage].map((item) => <Text key={item} style={styles.note}>• {item}</Text>)}
        {flow.artifact && <>
          <Text style={styles.label}>Title</Text><TextInput editable={!flow.busy} value={flow.artifact.title} onChangeText={(title) => flow.edit({ title })} style={styles.input} />
          {flow.stage === 'prompts' && <WriterPromptEditor content={flow.artifact.content} targetSeconds={targetDurationSeconds} disabled={flow.busy} onChange={(content) => flow.edit({ content })} />}
          <Text style={styles.label}>{flow.stage === 'prompts' ? 'Advanced scene / shot JSON (editable)' : 'Full document (editable)'}</Text>
          <TextInput ref={contentInput} onFocus={() => reveal(contentInput.current)} editable={!flow.busy} multiline textAlignVertical="top"
            value={flow.artifact.content} onChangeText={(content) => flow.edit({ content })} style={[styles.input, { minHeight: 360 }]} />
          {flow.stage === 'prompts' && <Text style={styles.note}>The approved screenplay is preserved on save. Change story text in step 2.</Text>}
          <View style={styles.row}>
            {flow.dirty && action('Discard edits', flow.discard, flow.busy)}
            {action('Save draft', () => void flow.save(false), flow.busy || briefChanged)}
            {action('Approve & save this stage', () => void flow.save(true), flow.busy || briefChanged || approved)}
          </View>
          {approved && nextStage && action('Continue to ' + WRITER_STAGE_LABELS[nextStage], () => { flow.chooseStage(nextStage); setNotes(''); }, flow.busy)}
          {approved && flow.stage === 'prompts' && action(flow.applied ? 'Production scenes saved' : 'Create production scenes (no video generation)', () => void flow.apply(), flow.busy || flow.applied)}
        </>}
      </View>
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  h1: { color: theme.text, fontSize: 25, fontWeight: '700', marginBottom: 2 },
  sub: { color: theme.textWeak, lineHeight: 20, marginBottom: 12 },
  label: { color: theme.textWeak, fontSize: 12, fontWeight: '700', marginTop: 10, textTransform: 'uppercase' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { minHeight: MIN_TAP, justifyContent: 'center', paddingHorizontal: 14, borderWidth: 1, borderColor: theme.line, borderRadius: 10, backgroundColor: theme.surface },
  chipOn: { borderColor: theme.accent, backgroundColor: 'rgba(166, 144, 255, 0.14)' },
  chipText: { color: theme.textWeak, fontWeight: '600' },
  chipTextOn: { color: theme.accent },
  input: { minHeight: MIN_TAP, borderWidth: 1, borderColor: theme.line, borderRadius: 10, backgroundColor: theme.surface, color: theme.text, paddingHorizontal: 12, paddingVertical: 10 },
  source: { minHeight: 150 },
  two: { flexDirection: 'row', gap: 10 },
  flex: { flex: 1 },
  note: { color: theme.textWeaker, fontSize: 12, lineHeight: 17 },
  primary: { minHeight: MIN_TAP, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: 10, backgroundColor: theme.accent },
  primaryText: { color: theme.bg, fontWeight: '800' },
  off: { opacity: 0.42 },
  message: { color: theme.textWeak, lineHeight: 19, marginTop: 8 },
  script: { padding: 12, borderWidth: 1, borderColor: theme.line, borderRadius: 10, backgroundColor: theme.surface, gap: 3 },
  scriptOn: { borderColor: theme.accent },
  scriptTitle: { color: theme.text, fontWeight: '700' },
  preview: { marginTop: 18, gap: 10, padding: 14, borderWidth: 1, borderColor: theme.line, borderRadius: 12, backgroundColor: theme.surface },
  previewTitle: { color: theme.text, fontSize: 19, fontWeight: '800' },
  screenplay: { color: theme.text, lineHeight: 21 },
  scene: { gap: 4, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.line },
  sceneText: { color: theme.textWeak, lineHeight: 19 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
  secondary: { minHeight: MIN_TAP, justifyContent: 'center', paddingHorizontal: 16, borderWidth: 1, borderColor: theme.line, borderRadius: 10 },
  secondaryText: { color: theme.text, fontWeight: '700' }
});
