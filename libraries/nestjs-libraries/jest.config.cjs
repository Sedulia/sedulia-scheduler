// Standalone jest config for the library's pure service and repository tests (node environment,
// a mocked Prisma, no database and no Nest runtime). Run from the repo root:
//   UPLOAD_DIRECTORY=/tmp/uploads node_modules/.bin/jest -c libraries/nestjs-libraries/jest.config.cjs
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/(.*)$': '<rootDir>/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/../helpers/src/$1',
    // ESM only, and the retention tests never sniff a file
    '^file-type$': '<rootDir>/src/database/prisma/retention/test-support/file.type.stub.cjs',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          module: 'commonjs',
          esModuleInterop: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          target: 'es2021',
        },
      },
    ],
  },
};
