// Standalone jest config for the backend's provisioning tests (node environment, mocked Prisma).
// The repo's root jest needs @nx/jest, so the backend carries its own, shaped like apps/frontend/jest.config.cjs.
// Run from the repository root:  node_modules/.bin/jest -c apps/backend/jest.config.cjs
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  moduleNameMapper: {
    '^@gitroom/backend/(.*)$': '<rootDir>/src/$1',
    '^@gitroom/helpers/(.*)$': '<rootDir>/../../libraries/helpers/src/$1',
    '^@gitroom/nestjs-libraries/(.*)$':
      '<rootDir>/../../libraries/nestjs-libraries/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          module: 'commonjs',
          esModuleInterop: true,
          target: 'es2020',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          isolatedModules: true,
        },
      },
    ],
  },
};
