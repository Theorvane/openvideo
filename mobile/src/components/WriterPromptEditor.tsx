import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { editWriterPromptShot, parseWriterPromptText } from '@openvideo/shared/writerPipeline';
import { writerDraftDurationMatchesTarget, writerDraftDurationSeconds, WRITER_DURATION_TOLERANCE_SECONDS } from '@openvideo/shared/writerWorkflow';
import { theme } from '../lib/theme';
import { MIN_TAP, press } from '../lib/touch';

export function WriterPromptEditor({ content, targetSeconds, disabled, onChange }: {
  readonly content: string; readonly targetSeconds: number; readonly disabled: boolean; readonly onChange: (content: string) => void;
}) {
  const [openScene, setOpenScene] = useState<number | null>(null);
  const draft = parseWriterPromptText(content);
  const textStyle = { color: theme.text, lineHeight: 20 };
  const inputStyle = { color: theme.text, minHeight: MIN_TAP, borderWidth: 1, borderColor: theme.line, padding: 10, borderRadius: 8 };
  if (!draft) return <Text style={textStyle}>Fix the JSON below to enable the shot editor. Incomplete JSON can still be saved as a draft.</Text>;
  const seconds = writerDraftDurationSeconds(draft);
  const timingMatches = writerDraftDurationMatchesTarget(draft, targetSeconds);
  return <View style={{ gap: 12 }}>
    <Text style={textStyle}>{draft.scenes.length} scenes · {seconds}s / {targetSeconds}s requested{timingMatches ? (seconds === targetSeconds ? ' — timing matches' : ` — within ±${WRITER_DURATION_TOLERANCE_SECONDS}s tolerance`) : ' — adjust before approval'}</Text>
    <Text style={textStyle}>Characters: {draft.characters.map((c) => c.name + ': ' + c.invariantDescription).join('\n')}</Text>
    {draft.scenes.map((scene, si) => <View key={si} style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: openScene === si }} onPress={() => setOpenScene(openScene === si ? null : si)} style={press({ minHeight: MIN_TAP, justifyContent: 'center' })}>
        <Text style={textStyle}>{si + 1}. {scene.title} — {scene.shots.reduce((n, s) => n + s.durationSeconds, 0)}s</Text>
      </Pressable>
      {openScene === si && <>
        <Text style={textStyle}>{scene.objective}\n{scene.setting} · {scene.timeOfDay}\n{scene.continuityNotes}</Text>
        {scene.shots.map((shot, sh) => <View key={sh} style={{ gap: 6, padding: 8, borderWidth: 1, borderColor: theme.line }}>
          <Text style={textStyle}>Shot {si + 1}.{sh + 1} · {shot.durationSeconds}s</Text>
          <TextInput accessibilityLabel={`Shot ${si + 1}.${sh + 1} duration in seconds`} editable={!disabled} keyboardType="number-pad" value={String(shot.durationSeconds)} style={inputStyle} onChangeText={(text) => {
            const durationSeconds = Number(text);
            if (Number.isInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 120) onChange(editWriterPromptShot(content, si, sh, { durationSeconds }));
          }} />
          {(['framing', 'cameraMotion', 'action', 'dialogue', 'negativePrompt'] as const).map((field) => <View key={field}>
            <Text style={textStyle}>{field === 'action' ? 'Video prompt / action' : field}</Text>
            <TextInput accessibilityLabel={`Shot ${si + 1}.${sh + 1} ${field}`} editable={!disabled} multiline value={shot[field]} style={inputStyle} onChangeText={(text) => onChange(editWriterPromptShot(content, si, sh, { [field]: text }))} />
          </View>)}
          <Text style={textStyle}>Audio cues (one per line)</Text>
          <TextInput accessibilityLabel={`Shot ${si + 1}.${sh + 1} audio cues`} editable={!disabled} multiline value={shot.audioCues.join('\n')} style={inputStyle} onChangeText={(text) => onChange(editWriterPromptShot(content, si, sh, { audioCues: text.split('\n') }))} />
        </View>)}
      </>}
    </View>)}
  </View>;
}
