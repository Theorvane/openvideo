import { lstat, readFile, readlink } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const readSource = async (url: URL): Promise<string> => (await readFile(url, 'utf8')).replace(/\r\n/g, '\n');

/**
 * That CI checks the mobile app at all.
 *
 * "Two Surfaces, One Core" in AGENTS.md requires the mobile typecheck on every
 * change that touches the app, and nothing enforced it: the workflow installed
 * only the root dependencies, so `mobile/` was never built and never checked.
 *
 * It showed up as something else entirely. The tests that cover mobile rules
 * import those modules, esbuild reads `mobile/tsconfig.json` to transform them,
 * that file extends `expo/tsconfig.base`, and with no mobile install the
 * transform failed before any assertion ran — a green suite locally and three
 * files failing on a tsconfig in CI.
 */

describe('the release pipeline', () => {
  it('publishes to Play only after everything that can fail has passed', async () => {
    // The two store jobs are not equally reversible. The iOS job uploads a
    // build and submits nothing; the Android job goes live to every user. Run
    // in parallel, an iOS failure after Play had already published left the
    // release shipped and untagged, and the retry collided on `versionCode`.
    const release = await readSource(new URL('../.github/workflows/release.yml', import.meta.url));

    expect(release).toMatch(/google-play:\n(?:.*\n)*?\s+needs: \[check, build, app-store-connect\]/);
    // And the tag still waits for both, or a failed upload would be recorded as
    // a release that shipped.
    expect(release).toMatch(/release:\n\s+needs: \[check, build, app-store-connect, google-play\]/);
  });
});

/**
 * Every workflow that claims to verify a commit, not just the one that was
 * fixed.
 *
 * The first version of this asserted `ci.yml` alone, and `release.yml` — which
 * runs its own verification with its own install steps — kept the identical
 * gap. It failed the 0.4.0 promotion on the same tsconfig, and before that it
 * had been passing 773 of 816 tests and calling the result a verified release.
 *
 * "The other workflow needs this too" is exactly what a person forgets, so the
 * list is the assertion.
 */
const VERIFYING_WORKFLOWS = ['ci.yml', 'release.yml'] as const;

describe.each(VERIFYING_WORKFLOWS)('%s', (workflow) => {
  const read = async () => readSource(new URL(`../.github/workflows/${workflow}`, import.meta.url));

  it('installs the mobile app before running the suite', async () => {
    const yaml = await read();
    expect(yaml).toMatch(/working-directory: mobile\n\s+run: npm ci/);
    // Or the tests transform against a tsconfig whose base is still missing.
    expect(yaml.indexOf('working-directory: mobile'), 'the mobile install must precede the tests').toBeLessThan(
      yaml.indexOf('npm test')
    );
  });

  it('typechecks the mobile app', async () => {
    // Required of every change that touches it — see "Two Surfaces, One Core"
    // in AGENTS.md — and a release gate must not verify less than a pull
    // request does.
    expect(await read()).toMatch(/working-directory: mobile\n\s+run: npm run typecheck/);
  });

  it('keys the dependency cache on both lockfiles', async () => {
    // Keyed on one, a mobile dependency change restores a tree that does not
    // match the install that follows it.
    expect(await read()).toContain('mobile/package-lock.json');
  });
});

/**
 * That the iOS signing step asks the profile what it is called.
 *
 * The 0.4.0 release failed to archive on
 * `No profile for team '5H9F8F82WT' matching 'macbook' found`. Not an expiry:
 * the certificate and the profile were rotated on one day and the variable
 * naming the profile still held a value from five weeks earlier, which was also
 * the date of the last release that worked. Two sources for one fact, and the
 * copy is the one nobody updates.
 */
describe('the iOS signing step', () => {
  const read = () => readSource(new URL('../.github/workflows/ios-app-store-connect.yml', import.meta.url));

  it('takes the profile name from the profile', async () => {
    const yaml = await read();
    expect(yaml).toContain('security cms -D -i "$PROFILE_PATH"');
    expect(yaml).toContain('plutil -extract Name raw');
    expect(yaml).toContain('PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME"');
    // The variable may still exist, but it must not be what the build signs
    // with — otherwise the drift simply comes back.
    expect(yaml).not.toContain('PROVISIONING_PROFILE_SPECIFIER="$APP_STORE_PROFILE_NAME"');
  });

  it('does not force a full CocoaPods CDN refresh, and retries transient failures', async () => {
    const yaml = await read();
    expect(yaml).not.toContain('pod install --repo-update');
    expect(yaml).toContain('for attempt in 1 2 3');
    expect(yaml).toContain('if pod install; then exit 0; fi');
  });

  it('checks the profile covers this app before spending an archive on it', async () => {
    // A mismatch used to cost a pod install and a full archive before xcodebuild
    // mentioned it.
    const yaml = await read();
    expect(yaml).toContain('plutil -extract Entitlements.application-identifier raw');
    expect(yaml).toMatch(/::error::The provisioning profile is for/);
    // A wildcard profile is legitimate, so it is matched rather than refused.
    expect(yaml).toMatch(/"\$\{PROFILE_APP_ID%\\\*\}"\*\)/);
  });
});

/**
 * That the Swift is compiled by something.
 *
 * The iOS export module was changed twice without anything ever building it.
 * The suite is TypeScript, the Android module is compiled by its own Gradle
 * build, and Swift had no equivalent — so a green CI said nothing at all about
 * half the native code, and a review had to point that out rather than a check.
 */
describe('the iOS module', () => {
  const read = () => readSource(new URL('../.github/workflows/ci.yml', import.meta.url));

  it('is built on every pull request', async () => {
    const yaml = await read();
    expect(yaml).toContain('ios-module:');
    expect(yaml).toContain('npx expo prebuild --platform ios');
    expect(yaml).toMatch(/xcodebuild[\s\S]{0,400}build/);
  });

  it('builds without needing a signing identity', async () => {
    // Certificates and profiles belong to a release, not to "does this
    // compile" — requiring them would make this run only where the secrets
    // are, which is exactly where it is least useful.
    const yaml = await read();
    expect(yaml).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(yaml).not.toMatch(/ios-module:[\s\S]*?APPLE_DISTRIBUTION_CERTIFICATE/);
  });
});

/**
 * That the Android app is assembled by something.
 *
 * It was not, and the gap was expensive twice in one change. The LevelPlay
 * binding does not compile against React Native 0.86 at all, and the Pangle
 * adapter throws `NoSuchMethodError` at init against the wrong SDK version —
 * both while the typecheck and 979 unit tests stayed green, because none of
 * them assemble anything. A review asked for build evidence and was right to.
 */
describe('the Android module', () => {
  const read = () => readSource(new URL('../.github/workflows/ci.yml', import.meta.url));

  it('is assembled on every pull request', async () => {
    const yaml = await read();
    expect(yaml).toContain('android-module:');
    expect(yaml).toContain('npx expo prebuild --platform android');
    expect(yaml).toContain('./gradlew assembleDebug');
  });

  it('checks the mediation adapters actually reached the Gradle files', async () => {
    // The unit tests read the config plugin's source, which proves what it
    // intends rather than what it produced. An adapter that never lands in
    // `app/build.gradle` is a network that silently never bids — and prebuild
    // is where that would go wrong.
    const yaml = await read();
    expect(yaml).toContain('ads-mediation:${artifact}');
    expect(yaml).toContain('artifact.bytedance.com/repository/pangle');
  });

  it('builds without needing the release keystore', async () => {
    // The signing config falls back to the debug key when the Gradle properties
    // are absent, which is what lets this run on a pull request rather than only
    // where the secrets are.
    const yaml = await read();
    expect(yaml).not.toMatch(/android-module:[\s\S]*?OPENSCENE_STORE_FILE/);
  });
});

describe('the AI approval auto-merge workflow', () => {
  const read = () => readSource(new URL('../.github/workflows/ai-approved-automerge.yml', import.meta.url));

  it('polls on the trusted default branch instead of relying on a fork review event token', async () => {
    const yaml = await read();
    expect(yaml).toContain('schedule:');
    expect(yaml).toContain("cron: '*/5 * * * *'");
    expect(yaml).toContain('workflow_dispatch:');
    expect(yaml).not.toContain('pull_request_review:');
    expect(yaml).not.toContain('github.event.review');
  });

  it('merges only current-head approvals from the dedicated reviewer without checking out PR code', async () => {
    const yaml = await read();
    expect(yaml).toContain('.author.login == "sjungwon03-ai"');
    expect(yaml).toContain('as $pr');
    expect(yaml).toContain('.commit.oid == $pr.headRefOid');
    expect(yaml).toContain('.baseRefName == "dev" or .baseRefName == "main"');
    expect(yaml).toContain('gh pr merge "$number" --repo "$GITHUB_REPOSITORY" --auto --squash --delete-branch');
    expect(yaml).not.toContain('actions/checkout');
  });
});

describe('the iOS renderer', () => {
  const read = () => readSource(new URL('../.github/workflows/ci.yml', import.meta.url));

  it('is exported from and measured, not only compiled', async () => {
    // Compiling proves a line exists. Every rendering bug this project has had
    // was found by exporting a file and reading it back, and iOS was the one
    // renderer nothing could export from until its composition was lifted out
    // of the Expo module.
    const yaml = await read();
    expect(yaml).toContain('ios-export:');
    expect(yaml).toContain('swift test');
    expect(yaml).toContain('mobile/modules/video-export/composer-tests');
  });

  it('tests the file the app builds rather than a copy of it', async () => {
    // The package's source is a symlink to `ios/VideoComposer.swift`. A copy
    // would drift, and a drifting copy passing its tests is worse than no
    // tests: it says the renderer works when what works is the copy.
    const source = new URL('../mobile/modules/video-export/composer-tests/Sources/VideoComposer/VideoComposer.swift', import.meta.url);
    const stats = await lstat(source);
    // Git checks out a symlink as a small file containing its target when the
    // Windows checkout cannot create links. In both representations, verify
    // the package still points at the app source rather than a drifting copy.
    const target = stats.isSymbolicLink() ? await readlink(source) : (await readFile(source, 'utf8')).trim();
    expect(target).toContain('ios/VideoComposer.swift');
  });
});
