import { createJsWithTsEsmPreset, type JestConfigWithTsJest } from 'ts-jest'

const MILLISECONDS = 1000;

const presetConfig = createJsWithTsEsmPreset({

})

const jestConfig: JestConfigWithTsJest = {
  ...presetConfig,
  collectCoverageFrom: [
    'src/**/*.{ts,tsx,js,jsx}'
  ],
  testTimeout: 60 * MILLISECONDS,
  // Résout les imports .js → .ts pour les fichiers TypeScript ESM
  // (convention ESM : les imports TS utilisent .js, le compilateur les résout)
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
}

export default jestConfig;