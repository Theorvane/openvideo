import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readRepo = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Writer surface parity', () => {
  it('uses the same shared generation and document application rules on desktop and mobile', async () => {
    const [desktop, mobile, desktopPromptEditor, mobilePromptEditor, preload, main, editor] = await Promise.all([
      readRepo('src/renderer/src/WriterWorkspace.tsx'),
      readRepo('mobile/src/screens/WriterScreen.tsx'),
      readRepo('src/renderer/src/WriterPromptEditor.tsx'),
      readRepo('mobile/src/components/WriterPromptEditor.tsx'),
      readRepo('src/preload/index.ts'),
      readRepo('src/main/registerWriterIpcHandler.ts'),
      readRepo('src/renderer/src/editor/useTimelineEditor.ts')
    ]);
    expect(desktop).toContain("from '../../shared/writerWorkflow'");
    expect(desktop).toContain('useWriterPipeline(document, onSave)');
    expect(desktop).toContain('customVideoStyle');
    expect(desktop).toContain('WRITER_VIDEO_STYLE_LABELS');
    expect(desktop).toContain('approvalBlockedReason');
    expect(desktopPromptEditor).toContain('writerDraftDurationMatchesTarget');
    expect(mobile).toContain("from '@openvideo/shared/writerWorkflow'");
    expect(mobile).toContain("from '@openvideo/shared/writerGeneration'");
    expect(mobile).toContain("isDomainModelAvailableOnRuntime(model, 'mobile')");
    expect(mobile).toContain('requestWriter({');
    expect(mobile).toContain('useWriterPipeline(project?.ai');
    expect(mobile).toContain('customVideoStyle');
    expect(mobile).toContain('WRITER_VIDEO_STYLE_LABELS');
    expect(mobilePromptEditor).toContain('writerDraftDurationMatchesTarget');
    for (const surface of [desktop, mobile]) {
      expect(surface).toContain('createUseWriterPipeline({ useEffect, useRef, useState })');
      expect(surface).toContain('canOpenWriterStage(');
      expect(surface).toContain('flow.save(true)');
      expect(surface).toContain('flow.save(false)');
      expect(surface).toContain('flow.apply()');
      expect(surface).toContain('flow.edit(');
      expect(surface).toContain('pipelineMatchesBrief(');
    }
    expect(preload).toContain('generateWriterDraft(input: WriterGenerationInput)');
    expect(main).toContain("const credentialKey = agentRouter ? AGENT_ROUTER_CREDENTIAL_KEY : 'geminiApiKey'");
    expect(main).toContain('getCredentialValue(credentialKey)');
    expect(main).toContain('requestWriter({');
    expect(main).toContain('requestAgentRouterCodexWriter({');
    expect(editor).toContain('current.id !== response.value.id');
    expect(editor).toContain('ai: response.value.ai');
  });

  it('keeps raw API keys out of desktop Writer components and IPC request types', async () => {
    const [desktop, workflow] = await Promise.all([
      readRepo('src/renderer/src/WriterWorkspace.tsx'),
      readRepo('src/shared/writerWorkflow.ts')
    ]);
    expect(desktop).not.toContain('apiKey');
    expect(workflow.slice(workflow.indexOf('export type WriterGenerationInput'), workflow.indexOf('export type WriterDraftCharacter'))).not.toContain('apiKey');
  });

  it('offers the same explicit approved-shot handoff without automatically rendering', async () => {
    const [desktop, mobile] = await Promise.all([
      readRepo('src/renderer/src/VideoGenerationWorkspace.tsx'), readRepo('mobile/src/screens/PlanScreen.tsx')
    ]);
    expect(desktop).toContain('approvedWriterShots(writerDocument)');
    expect(mobile).toContain('approvedWriterShots(activeProject?.ai)');
    expect(desktop).toContain('durationOptions.includes(shot.durationSeconds)');
    expect(mobile).toContain('supportedShotSeconds(model.id).includes(shot.durationSeconds)');
    expect(desktop).toContain('setPrompt(shot.prompt)');
    expect(mobile).toContain('setPrompt(shot.prompt)');
    expect(mobile).toContain('<SpendPrompt');
  });
});
