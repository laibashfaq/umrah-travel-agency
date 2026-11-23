/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  // App start-up (Nest + argon2 warm-up) and password hashing in setup can exceed Jest's 5s default.
  testTimeout: 60000,
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Generated Prisma client uses .js suffixes on relative TS imports.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
};
