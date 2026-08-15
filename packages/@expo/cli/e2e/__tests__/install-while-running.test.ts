/**
 * Copyright (c) 650 Industries, Inc. (Expo).
 *
 * End-to-end sanity check for https://github.com/expo/expo/issues/48950:
 * a package installed while the dev server runs must become resolvable
 * without a server restart. The order matters: the app imports the package
 * before the install, so the resolver caches the miss, and only a watcher
 * event can clear it. On Linux and Windows the dev server watches files
 * with `FallbackWatcher`.
 */
import fs from 'fs/promises';
import path from 'path';

import { createExpoStart, executeExpoAsync } from '../utils/expo';
import { executeAsync } from '../utils/process';
import { setupTestProjectWithOptionsAsync } from './utils';

// The dev server only watches files outside CI, and watching is the behavior
// under test, so remove the CI markers from the server's environment. An
// `undefined` value removes the variable from the child environment; an empty
// string would break the CLI's boolean environment parsing.
const expo = createExpoStart({
  env: {
    CI: undefined,
    CONTINUOUS_INTEGRATION: undefined,
    GITHUB_ACTIONS: undefined,
    BUILD_NUMBER: undefined,
    RUN_ID: undefined,
  } as unknown as Record<string, string>,
});

let projectRoot: string;

beforeAll(async () => {
  projectRoot = await setupTestProjectWithOptionsAsync('install-while-running', 'with-blank');

  // The app imports a package that is not installed yet, so the first build
  // fails and the resolver records the miss.
  await fs.writeFile(
    path.join(projectRoot, 'App.js'),
    [
      "import zipWith from 'lodash/zipWith';",
      'export default function App() {',
      "  return zipWith([1, 2], [10, 20], (a, b) => a + b).join(',');",
      '}',
      '',
    ].join('\n')
  );

  expo.options.cwd = projectRoot;
  await expo.startAsync();
});

afterAll(async () => {
  await expo.stopAsync();
});

it('resolves a package installed while the dev server runs (#48950)', async () => {
  // The package is absent, so the first build fails and caches the miss.
  await expect(expo.fetchBundleAsync('/App.bundle?platform=ios')).rejects.toThrowError(
    /Unable to resolve/
  );

  // Install the package with the project's package manager while the server
  // runs. This is the reproduction route from the issue.
  try {
    await executeExpoAsync(projectRoot, ['install', 'lodash']);
  } catch (error: any) {
    // A developer machine can have a global pnpm virtual-store config that
    // conflicts with the fixture install. Fall back to npm for the add; the
    // watcher sees equivalent writes either way.
    if (!`${error?.message}`.includes('ERR_PNPM_UNEXPECTED_VIRTUAL_STORE')) {
      throw error;
    }
    await executeAsync(projectRoot, ['npm', 'install', 'lodash', '--no-audit', '--no-fund']);
  }

  // Only a watcher event can clear the cached miss. Retry the same bundle
  // until the deadline; without the watch-before-read fix this never
  // succeeds, and on some platforms the pre-fix server crashes instead.
  const deadline = Date.now() + 90000;
  let bundleText: string | null = null;
  let lastError: Error | null = null;
  while (bundleText == null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const response = await expo.fetchBundleAsync('/App.bundle?platform=ios');
      expect(response.status).toBe(200);
      bundleText = await response.text();
    } catch (error: any) {
      lastError = error;
    }
  }

  if (bundleText == null) {
    throw new Error(
      `The newly installed package did not become resolvable before the deadline. ` +
        `Last error: ${lastError?.message}`
    );
  }
  expect(bundleText).toContain('zipWith');
});
